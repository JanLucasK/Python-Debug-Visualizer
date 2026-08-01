"""End-to-end tests for injecting the runtime into a foreign interpreter.

These run in a subprocess with an empty environment rather than in-process,
because the property under test is precisely that a clean interpreter -- one
that has never heard of this package and has nothing on its path -- ends up with
a working ``_pdv`` in ``sys.modules``.
"""

from __future__ import annotations

import subprocess
import sys
import textwrap

import pytest


def run_script(script: str) -> str:
    completed = subprocess.run(
        [sys.executable, "-c", textwrap.dedent(script)],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert completed.returncode == 0, completed.stderr
    return completed.stdout.strip()


def test_bootstrap_installs_runtime_in_clean_interpreter(bootstrap_expression):
    output = run_script(
        """
        import sys
        {expr}
        pdv = sys.modules["_pdv"]
        print(pdv.RUNTIME_VERSION)
        """.format(expr=bootstrap_expression)
    )
    from _pdv.version import RUNTIME_VERSION

    assert output == RUNTIME_VERSION


def test_bootstrap_leaves_no_trace_in_caller_frame(bootstrap_expression):
    """Injection must not introduce names into the user's scope.

    The debuggee's locals belong to the person debugging. A tool that quietly
    adds variables to the frame they are inspecting is corrupting the evidence.
    """
    output = run_script(
        """
        def user_function():
            local_before = set(dir())
            {expr}
            leaked = set(dir()) - local_before - {{"local_before"}}
            return sorted(leaked)

        print(user_function())
        """.format(expr=bootstrap_expression)
    )
    assert output == "[]"


def test_bootstrap_is_idempotent(bootstrap_expression):
    output = run_script(
        """
        import sys
        {expr}
        first = sys.modules["_pdv"]
        {expr}
        second = sys.modules["_pdv"]
        print(first is second)
        """.format(expr=bootstrap_expression)
    )
    assert output == "True"


def test_capture_works_after_bootstrap(bootstrap_expression):
    """The full call chain, in the exact single-expression form the extension uses."""
    output = run_script(
        """
        {expr}
        print(__import__("_pdv").capture([1.0, 2.0, 3.0]))
        """.format(expr=bootstrap_expression)
    )
    from _pdv import envelope

    document, payload = envelope.decode(output)
    assert document["ok"] is True
    assert document["descriptor"]["kind"] == "sequence"
    assert document["descriptor"]["stats"]["min"] == 1.0
    assert len(payload) == 3 * 8


def test_runtime_works_without_any_third_party_packages(bootstrap_expression):
    """A debuggee with no site-packages at all must still get a usable tool.

    `-S` skips site initialisation, which is the closest thing to a guarantee
    that nothing but the standard library is reachable.
    """
    completed = subprocess.run(
        [
            sys.executable,
            "-S",
            "-c",
            textwrap.dedent(
                """
                {expr}
                print(__import__("_pdv").capture(42))
                """.format(expr=bootstrap_expression)
            ),
        ],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert completed.returncode == 0, completed.stderr

    from _pdv import envelope

    document, _ = envelope.decode(completed.stdout.strip())
    assert document["ok"] is True
    assert document["descriptor"]["kind"] == "scalar"


def test_reinstalls_when_the_code_changed(bootstrap_expression):
    """The failure this prevents, which cost a real debugging session.

    A debuggee installs the runtime once and keeps it. The check for "already
    installed" used to compare a hand-maintained version string, so editing the
    runtime without bumping it meant the new code never reached a session that
    was already running: the bootstrap ran, saw a matching version, and returned
    without doing anything. A newly added adapter simply did nothing, and the
    only cure was restarting the whole debug session.

    The marker is now derived from the sources, so any edit invalidates it.
    """
    output = run_script(
        """
        import sys, types

        # A runtime from an earlier build, complete with its own marker.
        old = types.ModuleType("_pdv")
        old.__pdv_build__ = "0.0.1+000000000000"
        old.marker = "old"
        sys.modules["_pdv"] = old

        {expr}

        print(getattr(sys.modules["_pdv"], "marker", "replaced"))
        """.format(expr=bootstrap_expression)
    )
    assert output == "replaced", "a stale runtime was left in place"


def test_diagnostics_reports_the_build_marker(bootstrap_expression):
    output = run_script(
        """
        {expr}
        print(__import__("_pdv").diagnostics())
        """.format(expr=bootstrap_expression)
    )
    from _pdv import envelope

    document, _ = envelope.decode(output)
    assert document["build"], "diagnostics must report the build the loader stamped"
    assert document["build"].startswith(document["runtimeVersion"])


def test_build_marker_changes_with_the_sources():
    """Two different source sets must not share an identity."""
    import hashlib
    import json

    from conftest import collect_sources

    first = json.dumps(collect_sources())
    altered = json.dumps({**collect_sources(), "_pdv.extra": ["# new module", False]})

    digest = lambda text: hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]
    assert digest(first) != digest(altered)
