"""Shared helpers for assembling a payload buffer.

Adapters never manage byte offsets themselves. They hand buffers to a
:class:`PayloadBuilder`, which lays them out end to end and hands back the
:class:`Channel` metadata pointing into the result. Getting an offset wrong
produces plausible-looking garbage rather than an error, so it is worth having
exactly one implementation of it.
"""

from __future__ import annotations

from typing import Any, List, Optional

from .descriptor import BYTES_PER_ELEMENT, Channel, NumericStats

#: Cap on the `preview` repr. Long enough to identify a value, short enough that
#: a pathological __repr__ cannot stall the debuggee or bloat the envelope.
PREVIEW_LIMIT = 300


class PayloadBuilder:
    def __init__(self) -> None:
        self._chunks: List[bytes] = []
        self._offset = 0
        self.channels: List[Channel] = []

    def add(
        self,
        name: str,
        role: str,
        dtype: str,
        data: bytes,
        length: int,
        stats: Optional[NumericStats] = None,
    ) -> Channel:
        expected = BYTES_PER_ELEMENT[dtype] * length
        if len(data) != expected:
            raise ValueError(
                "channel {!r}: got {} bytes, expected {} for {} x {}".format(
                    name, len(data), expected, length, dtype
                )
            )
        channel = Channel(
            name=name,
            role=role,
            dtype=dtype,
            length=length,
            byte_offset=self._offset,
            byte_length=len(data),
            stats=stats,
        )
        self.channels.append(channel)
        self._chunks.append(data)
        self._offset += len(data)
        return channel

    def build(self) -> bytes:
        return b"".join(self._chunks)


def qualified_type(value: Any) -> str:
    """``"numpy.ndarray"`` rather than just ``"ndarray"``."""
    cls = type(value)
    module = getattr(cls, "__module__", None)
    name = getattr(cls, "__qualname__", getattr(cls, "__name__", "?"))
    if module in (None, "builtins"):
        return name
    return "{}.{}".format(module, name)


def preview(value: Any, limit: int = PREVIEW_LIMIT) -> str:
    """A short, always-safe repr.

    User ``__repr__`` implementations are arbitrary code that can raise, block or
    return megabytes. All three are handled here so no caller has to think about
    it.
    """
    try:
        text = repr(value)
    except Exception as exc:
        return "<repr failed: {}>".format(type(exc).__name__)
    if not isinstance(text, str):  # a __repr__ returning non-str is legal to write, if not to run
        return "<repr returned {}>".format(type(text).__name__)
    if len(text) > limit:
        return text[: limit - 1] + "…"
    return text
