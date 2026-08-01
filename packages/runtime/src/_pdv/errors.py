"""Error types and the guarantee that we never break the debuggee.

Nothing this runtime does may raise into the user's process. A visualizer that
can crash the program you are trying to debug is worse than no visualizer, so
every entry point funnels failures into a structured payload instead.
"""

from __future__ import annotations

import traceback as _traceback
from typing import Any, Dict, Optional


class CaptureError(Exception):
    """A failure we produced deliberately, with a message meant for the user."""

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message


def describe_exception(exc: BaseException, *, include_traceback: bool = True) -> Dict[str, Any]:
    """Turn any exception into the wire's error shape."""
    if isinstance(exc, CaptureError):
        kind = exc.kind
        message = exc.message
    else:
        kind = type(exc).__name__
        message = str(exc) or repr(exc)

    tb: Optional[str] = None
    if include_traceback:
        try:
            tb = "".join(
                _traceback.format_exception(type(exc), exc, exc.__traceback__)
            )
        except Exception:  # pragma: no cover - formatting a traceback should never fail
            tb = None

    return {"type": kind, "message": message, "traceback": tb}
