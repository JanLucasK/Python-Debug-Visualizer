"""Adapter installation.

Built-in adapters are registered eagerly because they cost nothing. Everything
that depends on a third-party library is registered *lazily*, keyed on the
module name, and only materialises once the debuggee has already imported it.

That gating is not an optimisation. Importing torch into a process that had not
imported it can initialise CUDA and take seconds; importing anything at all
changes the state of the program under debug. A tool that alters the program you
are inspecting is not a debugging tool.
"""

from __future__ import annotations

from ..registry import Registry
from . import builtins_


def install(registry: Registry) -> None:
    builtins_.install(registry)
    registry.register_lazy("numpy", _install_numpy)


def _install_numpy(registry: Registry) -> None:
    from . import numpy_

    numpy_.install(registry)
