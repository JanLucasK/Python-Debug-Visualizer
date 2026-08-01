"""Getting bulk bytes out of the debuggee.

Small payloads ride along inside the evaluate response, which needs nothing and
works everywhere. Large ones do not: base64 inside JSON inside a debug-adapter
message costs about 35% in size and a full copy at every layer, and the whole
round trip is synchronous with the debugger.

So above a threshold the bytes leave by a side channel, in order of preference:

1. **socket** — the debuggee dials a loopback listener in the extension host.
   Safe under Remote-SSH and dev containers, where both run on the same machine.
2. **file** — a temp file, for the one topology loopback cannot cross: debuggee
   and extension host in different containers sharing a volume.
3. **inline** — always available, and therefore the floor. A slow plot beats no
   plot, so every failure ends here rather than as an error.

Nothing here may raise. A transport that fails takes the next option down.
"""

from __future__ import annotations

import os
import socket
import struct
import tempfile
import time
from typing import Any, Dict, Optional, Tuple

#: Below this, the side channel costs more in setup than it saves in transfer.
DEFAULT_THRESHOLD = 64 * 1024

#: The debuggee is paused and the user is waiting; a listener that is not there
#: within a second is not going to be.
CONNECT_TIMEOUT_SECONDS = 1.0
SEND_TIMEOUT_SECONDS = 30.0

_LENGTH = struct.Struct("<Q")


def deliver(payload: bytes, options: Dict[str, Any]) -> Tuple[Dict[str, Any], bytes]:
    """Choose a route for ``payload``.

    Returns the payload descriptor and the bytes to append to the envelope --
    empty unless the route is inline.
    """
    if not payload:
        return {"encoding": "none"}, b""

    settings = options.get("transport") or {}
    threshold = _positive_int(settings.get("threshold"), DEFAULT_THRESHOLD)

    if len(payload) < threshold:
        return _inline(payload)

    port = _positive_int(settings.get("port"), 0)
    token = settings.get("token")
    if port and isinstance(token, str) and token:
        if _send_over_socket(payload, port, token):
            return {"encoding": "socket", "token": token, "byteLength": len(payload)}, b""

    path = _write_to_file(payload)
    if path is not None:
        return {"encoding": "file", "path": path, "byteLength": len(payload)}, b""

    return _inline(payload)


def _inline(payload: bytes) -> Tuple[Dict[str, Any], bytes]:
    return {"encoding": "inline", "byteLength": len(payload)}, payload


def _send_over_socket(payload: bytes, port: int, token: str) -> bool:
    """Frame: token line, 8-byte length, bytes. True if it all went out."""
    connection = None
    try:
        connection = socket.create_connection(("127.0.0.1", port), CONNECT_TIMEOUT_SECONDS)
        connection.settimeout(SEND_TIMEOUT_SECONDS)
        connection.sendall(token.encode("ascii") + b"\n" + _LENGTH.pack(len(payload)) + payload)
        # Half-close so the reader sees the end of the stream, then wait for the
        # peer to close: dropping the socket immediately can discard buffered
        # bytes before they are delivered.
        connection.shutdown(socket.SHUT_WR)
        connection.recv(1)
        return True
    except (OSError, ValueError):
        return False
    finally:
        if connection is not None:
            try:
                connection.close()
            except OSError:
                pass


#: Age at which an unclaimed payload file is assumed abandoned.
STALE_FILE_SECONDS = 3600

_FILE_PREFIX = "pdv-"
_FILE_SUFFIX = ".bin"


def _sweep_abandoned_files() -> None:
    """Delete payload files nobody came to collect.

    The extension removes each file after reading it, but it is not guaranteed
    to get the chance: a closed panel, a killed window or a crashed capture all
    leave one behind. Without this, a long-lived process debugged repeatedly
    would fill its temp directory with megabytes of arrays nobody will ever
    look at again.
    """
    try:
        directory = tempfile.gettempdir()
        cutoff = time.time() - STALE_FILE_SECONDS
        for name in os.listdir(directory):
            if not (name.startswith(_FILE_PREFIX) and name.endswith(_FILE_SUFFIX)):
                continue
            path = os.path.join(directory, name)
            try:
                if os.path.getmtime(path) < cutoff:
                    os.unlink(path)
            except OSError:
                pass  # someone else's file, or already gone
    except OSError:
        pass


def _write_to_file(payload: bytes) -> Optional[str]:
    """A temp file the extension reads and deletes.

    Written to the debuggee's temp directory, which is the one place both sides
    are known to reach in the container-sharing-a-volume case this exists for.
    """
    _sweep_abandoned_files()
    handle = None
    try:
        handle, path = tempfile.mkstemp(prefix=_FILE_PREFIX, suffix=_FILE_SUFFIX)
        with os.fdopen(handle, "wb") as stream:
            handle = None  # ownership passed to the context manager
            stream.write(payload)
        return path
    except OSError:
        if handle is not None:
            try:
                os.close(handle)
            except OSError:
                pass
        return None


def _positive_int(value: Any, fallback: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return fallback
    return number if number > 0 else fallback
