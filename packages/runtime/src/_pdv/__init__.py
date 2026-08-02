"""Python Debug Plots runtime.

This package runs *inside the process being debugged*. Two consequences shape
everything in it:

1. It has no dependencies and never imports one. Integrations are discovered
   from ``sys.modules``; see :mod:`_pdv.adapters`.
2. It must not raise. :func:`capture` converts every failure into a structured
   response, because an exception escaping into the debuggee would be a bug in a
   tool whose entire job is to make bugs easier to find.

Normally the extension injects this package; nothing needs to be installed in
the debuggee. It is also pip-installable, which is what makes the adapter API
usable from your own code:

    >>> import _pdv
    >>> @_pdv.register_adapter
    ... class MyAdapter(_pdv.Adapter):
    ...     ...
"""

from __future__ import annotations

from .adapters import install as _install_adapters
from .descriptor import Capture, Channel, Descriptor, NumericStats
from .extract import capture, diagnostics
from .errors import CaptureError
from .registry import Adapter, register_adapter, registry
from .version import PROTOCOL_VERSION, RUNTIME_VERSION

__all__ = [
    "Adapter",
    "Capture",
    "CaptureError",
    "Channel",
    "Descriptor",
    "NumericStats",
    "PROTOCOL_VERSION",
    "RUNTIME_VERSION",
    "capture",
    "diagnostics",
    "register_adapter",
    "registry",
]

_install_adapters(registry)
