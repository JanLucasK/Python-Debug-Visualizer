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
