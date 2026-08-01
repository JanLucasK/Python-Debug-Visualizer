"""The single entry point the extension calls inside the debuggee.

Everything about this module is shaped by one rule: it must never raise into the
program being debugged, and it must never return something the extension cannot
parse. Both failure modes are handled by falling back to progressively simpler
error envelopes.

Named ``extract`` rather than ``capture`` so that the module is not shadowed by
the ``capture`` function re-exported from the package root.
"""

from __future__ import annotations

import base64
import json
import time
from typing import Any, Dict

from . import envelope, transport
from .errors import CaptureError, describe_exception
from .registry import registry
from .version import PROTOCOL_VERSION


#: Sentinel for "no x expression given", since None is a legitimate value.
_NO_X = object()


def capture(value: Any, options_b64: str = "", x: Any = _NO_X) -> str:
    """Extract ``value`` and return a repr-safe envelope string.

    ``options_b64`` is base64-encoded JSON rather than plain JSON for the same
    reason the response is base64: the call is assembled into a Python
    expression as source text, and base64 is the only encoding guaranteed to
    survive that without a quoting layer.

    ``x`` is a second value to use as the horizontal axis, evaluated by the
    caller in the same frame. It is passed as a real argument rather than named
    inside the options, because it is data rather than configuration and must
    not be forced through JSON.
    """
    started = time.perf_counter()
    options = _decode_options(options_b64)
    if x is not _NO_X:
        options["_x"] = x

    try:
        adapter = registry.resolve(value)
        if adapter is None:
            raise CaptureError(
                "NoAdapter",
                "No adapter could handle a value of type {!r}.".format(type(value).__name__),
            )
        result = adapter.build(value, options)
        # Large payloads leave by a side channel; see _pdv.transport. What comes
        # back is the descriptor of the route taken and whatever still has to
        # ride inside the envelope.
        payload_descriptor, inline = transport.deliver(result.payload, options)

        document: Dict[str, Any] = {
            "v": PROTOCOL_VERSION,
            "ok": True,
            "descriptor": result.descriptor.to_dict(),
            "payload": payload_descriptor,
            "warnings": list(result.warnings),
            "elapsedMs": _elapsed_ms(started),
        }
        return envelope.encode(document, inline)
    except Exception as exc:  # noqa: BLE001 - deliberately broad; see module docstring
        return _error_envelope(exc)


def diagnostics() -> str:
    """Report runtime state. Used by the extension to verify a successful injection."""
    import sys

    from .version import RUNTIME_VERSION

    return envelope.encode(
        {
            "v": PROTOCOL_VERSION,
            "ok": True,
            "runtimeVersion": RUNTIME_VERSION,
            # Stamped by the bootstrap loader; identifies the exact code, which
            # the release version alone does not.
            "build": getattr(sys.modules.get("_pdv"), "__pdv_build__", None),
            "adapters": registry.adapter_names(),
        }
    )


def _decode_options(options_b64: str) -> Dict[str, Any]:
    if not options_b64:
        return {}
    try:
        decoded = json.loads(base64.b64decode(options_b64).decode("utf-8"))
    except Exception:
        # Malformed options are the extension's bug, not the user's. Falling back
        # to defaults still produces a useful plot; failing would not.
        return {}
    return decoded if isinstance(decoded, dict) else {}


def _elapsed_ms(started: float) -> float:
    return round((time.perf_counter() - started) * 1000.0, 3)


def _error_envelope(exc: BaseException) -> str:
    document = {"v": PROTOCOL_VERSION, "ok": False, "error": describe_exception(exc)}
    try:
        return envelope.encode(document)
    except Exception:
        # The traceback itself was unencodable (surrogates in a filename, say).
        # Retry without it rather than losing the error entirely.
        minimal = {
            "v": PROTOCOL_VERSION,
            "ok": False,
            "error": {
                "type": type(exc).__name__,
                "message": "Error could not be serialized.",
                "traceback": None,
            },
        }
        return envelope.encode(minimal)
