"""The envelope that carries a capture out of the debuggee.

Why this exists at all is worth spelling out, because it is the single thing
that most existing tools get wrong.

A DAP ``evaluate`` request returns the debug adapter's *repr* of the result. If
the runtime returns a JSON string, what actually comes back is a Python string
literal: quoted, with embedded quotes and backslashes escaped. Un-escaping that
correctly is much harder than it looks, and getting it wrong corrupts exactly
the data that matters — Windows paths, regexes, anything containing a backslash.

So we sidestep the problem instead of fighting it. The envelope is encoded with
base64, whose alphabet (``A-Za-z0-9+/=``) contains no character that repr will
ever escape. The response is therefore the payload wrapped in one pair of
quotes, and nothing else — a transformation that is trivially and totally
reversible.

Layout, before base64::

    zlib( u32le(json_length) || json_utf8 || payload_bytes )

Compressing the concatenation rather than base64-ing the payload separately
avoids paying the 33% base64 tax twice, and descriptors compress extremely well.
"""

from __future__ import annotations

import base64
import json
import struct
import zlib
from typing import Any, Dict

#: zlib level 1 is a deliberate choice: on the multi-megabyte payloads that
#: matter, the compressor stops being free and starts being the bottleneck,
#: while level 1 still removes most of the redundancy in the JSON header.
_COMPRESS_LEVEL = 1

_HEADER = struct.Struct("<I")


def encode(document: Dict[str, Any], payload: bytes = b"") -> str:
    """Pack a JSON-able document plus raw bytes into a repr-safe ASCII string."""
    raw = json.dumps(document, separators=(",", ":"), allow_nan=False).encode("utf-8")
    body = _HEADER.pack(len(raw)) + raw + payload
    return base64.b64encode(zlib.compress(body, _COMPRESS_LEVEL)).decode("ascii")


def decode(encoded: str) -> "tuple[Dict[str, Any], bytes]":
    """Inverse of :func:`encode`. Used only by the test suite; the extension has its own."""
    body = zlib.decompress(base64.b64decode(encoded))
    (json_length,) = _HEADER.unpack_from(body, 0)
    start = _HEADER.size
    document = json.loads(body[start : start + json_length].decode("utf-8"))
    return document, body[start + json_length :]
