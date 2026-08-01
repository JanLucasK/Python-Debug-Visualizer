"""End-to-end tests against a real debugpy session.

Everything else in this suite calls the runtime directly. These tests reach it
the way the extension does -- over the Debug Adapter Protocol, through
debugpy -- because the design rests on two claims about debugpy's behaviour that
no amount of unit testing can confirm:

1. `context: "clipboard"` returns evaluate results without the 64 KiB
   truncation that applies everywhere else.
2. A single `exec(...)` expression is enough to install the runtime, even
   though clipboard context does not permit statements.

If either turns out to be wrong, the whole transport design is wrong, and it is
much better to find that out here than in a bug report.
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

from _pdv import envelope

pytest.importorskip("debugpy")
pytest.importorskip("numpy")

sys.path.insert(0, str(Path(__file__).parent))
from dap.client import DapClient  # noqa: E402

TARGET = Path(__file__).parent / "dap" / "target.py"


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


@pytest.fixture(scope="module")
def debug_session(bootstrap_expression):
    """A paused debugpy process with the runtime already injected."""
    # The debugpy *adapter* in debugServer mode, which is precisely what VS Code
    # connects to. Talking to the server port directly would exercise a
    # different protocol path than the extension ever uses.
    port = free_port()
    process = subprocess.Popen(
        [sys.executable, "-m", "debugpy.adapter", "--host", "127.0.0.1", "--port", str(port)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )

    client = None
    try:
        deadline = time.time() + 60
        while True:
            try:
                client = DapClient(port=port)
                break
            except OSError:
                if time.time() > deadline or process.poll() is not None:
                    raise RuntimeError(
                        "the debugpy adapter never started: {}".format(
                            (process.stderr.read() if process.stderr else b"").decode()
                        )
                    )
                time.sleep(0.1)

        frame_id = client.launch_and_wait_for_stop(str(TARGET), sys.executable)

        # This is the bootstrap, over the real wire, in the real context.
        response = client.evaluate(bootstrap_expression, frame_id)
        assert response["success"], response.get("message")

        yield client, frame_id
    finally:
        if client:
            client.close()
        process.kill()
        process.wait(timeout=30)


def capture(client, frame_id, expression, context="clipboard", raw_string=True):
    response = client.evaluate(
        f'__import__("_pdv").capture({expression})',
        frame_id,
        context=context,
        raw_string=raw_string,
    )
    assert response["success"], response.get("message")
    return response["body"]["result"]


def test_runtime_installs_over_dap(debug_session):
    client, frame_id = debug_session
    raw = client.evaluate('__import__("_pdv").diagnostics()', frame_id)["body"]["result"]
    document, _ = envelope.decode(raw)

    assert document["ok"] is True
    assert "numpy.ndarray" in document["adapters"], (
        "the numpy adapter should have materialised, since the debuggee imported numpy"
    )


def test_small_capture_roundtrips(debug_session):
    client, frame_id = debug_session
    document, payload = envelope.decode(capture(client, frame_id, "small"))

    assert document["descriptor"]["shape"] == [3]
    assert document["descriptor"]["stats"]["max"] == 3.0
    assert len(payload) == 3 * 8


def test_clipboard_context_is_not_truncated(debug_session):
    """The claim the entire transport design rests on."""
    client, frame_id = debug_session
    raw = capture(client, frame_id, "large")

    assert len(raw) > 65_536, (
        "expected a payload past debugpy's 64 KiB limit; got {} chars, "
        "so this test is no longer proving anything".format(len(raw))
    )

    document, payload = envelope.decode(raw)
    assert document["ok"] is True
    # Statistics describe all million elements even though far fewer travelled.
    assert document["descriptor"]["stats"]["count"] == 1_000_000
    assert document["descriptor"]["decimation"]["originalLength"] == 1_000_000
    assert len(payload) > 0


def test_the_truncation_limit_is_real(debug_session):
    """Establishes that there is something to bypass in the first place.

    Without either bypass, debugpy cuts the result at
    `SafeRepr.maxstring_outer = 2**16`. This is the wall the closest comparable
    extension has been stuck behind for years, and the reason the rest of the
    transport design looks the way it does.
    """
    client, frame_id = debug_session
    truncated = capture(client, frame_id, "large", context="repl", raw_string=False)

    assert len(truncated) < 70_000, (
        "repl context returned {} chars, so debugpy no longer truncates and the "
        "bypasses below may be unnecessary".format(len(truncated))
    )
    with pytest.raises(Exception):
        envelope.decode(truncated)


@pytest.mark.parametrize(
    "context,raw_string",
    [
        ("clipboard", False),  # the context bypass alone
        ("repl", True),  # the rawString bypass alone
        ("clipboard", True),  # what the extension actually sends
    ],
)
def test_both_truncation_bypasses_work_independently(debug_session, context, raw_string):
    """Two independent bypasses, which is why the extension uses both.

    debugpy lifts the limit for `context: "clipboard"`, and separately for
    `format: {rawString: true}`. Either alone is sufficient today. Sending both
    means a future debugpy dropping support for one still leaves a working
    extension rather than a silently corrupted plot -- and `rawString` in
    particular is a debugpy extension to DAP with no guarantee behind it.
    """
    client, frame_id = debug_session
    raw = capture(client, frame_id, "large", context=context, raw_string=raw_string)

    assert len(raw) > 65_536
    document, _ = envelope.decode(raw)
    assert document["descriptor"]["stats"]["count"] == 1_000_000


def test_backslashes_survive_the_round_trip(debug_session):
    client, frame_id = debug_session
    document, _ = envelope.decode(capture(client, frame_id, "windows_path"))

    assert document["descriptor"]["preview"] == r"'C:\\Users\\jan\\re\\.\\d+'"


def test_nan_gaps_survive_decimation_over_the_wire(debug_session):
    client, frame_id = debug_session
    document, _ = envelope.decode(capture(client, frame_id, "with_gaps"))

    assert document["descriptor"]["stats"]["nanCount"] == 500
    assert document["descriptor"]["decimation"]["method"] == "minmax"
