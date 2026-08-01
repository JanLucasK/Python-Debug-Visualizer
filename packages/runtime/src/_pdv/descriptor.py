"""Wire-shape dataclasses.

These mirror ``packages/protocol/src/descriptor.ts`` one-to-one. Python uses
snake_case internally and the wire uses camelCase, so each class owns an
explicit ``to_dict``. The duplication is deliberate: it is the one place where a
protocol change forces a visible edit on the Python side, which is exactly what
you want at a version boundary.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

# Element types that may go on the wire. Anything else must be converted by the
# adapter, with the original recorded in `Descriptor.dtype`.
WIRE_DTYPES = frozenset(
    {"f32", "f64", "i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "bool"}
)

BYTES_PER_ELEMENT = {
    "f32": 4,
    "f64": 8,
    "i8": 1,
    "i16": 2,
    "i32": 4,
    "i64": 8,
    "u8": 1,
    "u16": 2,
    "u32": 4,
    "u64": 8,
    "bool": 1,
}


@dataclass
class NumericStats:
    """Summary statistics over the *complete* value, never over a subsample.

    See the note in the TypeScript mirror: decimation must not change these
    numbers, or the stats strip starts quietly lying about the data.
    """

    count: int
    min: Optional[float] = None
    max: Optional[float] = None
    mean: Optional[float] = None
    std: Optional[float] = None
    nan_count: int = 0
    inf_count: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "count": int(self.count),
            "min": _finite_or_none(self.min),
            "max": _finite_or_none(self.max),
            "mean": _finite_or_none(self.mean),
            "std": _finite_or_none(self.std),
            "nanCount": int(self.nan_count),
            "infCount": int(self.inf_count),
        }


@dataclass
class Channel:
    """One contiguous run of numbers inside the payload buffer."""

    name: str
    role: str
    dtype: str
    length: int
    byte_offset: int
    byte_length: int
    stats: Optional[NumericStats] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "role": self.role,
            "dtype": self.dtype,
            "length": int(self.length),
            "byteOffset": int(self.byte_offset),
            "byteLength": int(self.byte_length),
            "stats": self.stats.to_dict() if self.stats else None,
        }


@dataclass
class Decimation:
    method: str
    original_length: int
    output_length: int

    def to_dict(self) -> Dict[str, Any]:
        return {
            "method": self.method,
            "originalLength": int(self.original_length),
            "outputLength": int(self.output_length),
        }


@dataclass
class IndexInfo:
    kind: str
    name: Optional[str] = None
    dtype: Optional[str] = None
    channel: Optional[str] = None
    time_unit: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "kind": self.kind,
            "name": self.name,
            "dtype": self.dtype,
            "channel": self.channel,
            "timeUnit": self.time_unit,
        }


@dataclass
class ColumnInfo:
    name: str
    dtype: str
    numeric: bool
    channel: Optional[str] = None
    stats: Optional[NumericStats] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "dtype": self.dtype,
            "numeric": bool(self.numeric),
            "channel": self.channel,
            "stats": self.stats.to_dict() if self.stats else None,
        }


@dataclass
class Descriptor:
    kind: str
    python_type: str
    preview: str
    shape: Optional[List[int]] = None
    dtype: Optional[str] = None
    nbytes: Optional[int] = None
    stats: Optional[NumericStats] = None
    index: Optional[IndexInfo] = None
    columns: Optional[List[ColumnInfo]] = None
    channels: List[Channel] = field(default_factory=list)
    decimation: Optional[Decimation] = None
    truncated: bool = False
    suggested_viz: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "kind": self.kind,
            "pythonType": self.python_type,
            "preview": self.preview,
            "shape": [int(d) for d in self.shape] if self.shape is not None else None,
            "dtype": self.dtype,
            "nbytes": int(self.nbytes) if self.nbytes is not None else None,
            "stats": self.stats.to_dict() if self.stats else None,
            "index": self.index.to_dict() if self.index else None,
            "columns": [c.to_dict() for c in self.columns] if self.columns is not None else None,
            "channels": [c.to_dict() for c in self.channels],
            "decimation": self.decimation.to_dict() if self.decimation else None,
            "truncated": bool(self.truncated),
            "suggestedViz": list(self.suggested_viz),
        }


@dataclass
class Capture:
    """An adapter's complete answer: metadata plus the raw bytes it references."""

    descriptor: Descriptor
    payload: bytes = b""
    warnings: List[str] = field(default_factory=list)


def _finite_or_none(value: Optional[float]) -> Optional[float]:
    """Keep NaN and Inf out of the JSON, which cannot represent them.

    Note this only guards *statistics*. Actual data values keep their NaN and
    Inf bit patterns, because they travel as raw binary rather than as JSON.
    """
    if value is None:
        return None
    value = float(value)
    if value != value or value in (float("inf"), float("-inf")):
        return None
    return value
