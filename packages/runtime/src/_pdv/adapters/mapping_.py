"""Adapter for dictionaries of numeric sequences.

``{"raw": raw, "smoothed": smoothed}`` is the obvious way to say "plot these
together", and it needs no library at all — so it is handled here rather than
requiring people to build a DataFrame to overlay two arrays.

The output is deliberately the same shape a DataFrame produces: one named
channel per entry, sharing one x axis. The line plot already draws that, so
nothing downstream had to learn about mappings.
"""

from __future__ import annotations

import math
import sys
from typing import Any, Dict, List, Optional, Sequence, Tuple

from ..codec import PayloadBuilder, preview, qualified_type
from ..descriptor import Capture, ColumnInfo, Decimation, Descriptor, NumericStats
from ..registry import Adapter, Registry
from . import builtins_, numpy_

#: Entries plotted before we stop and say so.
MAX_ENTRIES = 32


class MappingAdapter(Adapter):
    name = "builtins.mapping"

    def score(self, value: Any) -> int:
        # Above the fallback, below every library adapter -- a pandas or numpy
        # value that happens to be dict-like should still go to its own adapter.
        return 35 if isinstance(value, dict) else 0

    def build(self, value: Any, options: Dict[str, Any]) -> Capture:
        np = sys.modules.get("numpy")
        warnings: List[str] = []

        vectors: List[Tuple[str, Any]] = []
        skipped: List[str] = []
        for key, item in value.items():
            vector = _as_vector(np, item)
            if vector is None:
                skipped.append(str(key))
            else:
                vectors.append((str(key), vector))

        if not vectors:
            return _describe_only(
                value,
                ["No entry in this mapping is a flat sequence of numbers."],
            )

        if skipped:
            warnings.append(
                "{} entr{} skipped as non-numeric: {}.".format(
                    len(skipped),
                    "y" if len(skipped) == 1 else "ies",
                    ", ".join(skipped[:5]) + ("…" if len(skipped) > 5 else ""),
                )
            )

        # Entries of different lengths cannot share an x axis, and stretching
        # them onto one would put points where the data has none. The majority
        # length wins and the rest are reported.
        lengths: Dict[int, int] = {}
        for _, vector in vectors:
            lengths[len(vector)] = lengths.get(len(vector), 0) + 1
        common = max(lengths, key=lambda length: (lengths[length], length))

        mismatched = [name for name, vector in vectors if len(vector) != common]
        if mismatched:
            warnings.append(
                "{} entr{} of a different length skipped: {}.".format(
                    len(mismatched),
                    "y" if len(mismatched) == 1 else "ies",
                    ", ".join(mismatched[:5]) + ("…" if len(mismatched) > 5 else ""),
                )
            )
        vectors = [(name, vector) for name, vector in vectors if len(vector) == common]

        if len(vectors) > MAX_ENTRIES:
            warnings.append(
                "Showing the first {} of {} numeric entries.".format(MAX_ENTRIES, len(vectors))
            )
            vectors = vectors[:MAX_ENTRIES]

        if options.get("viz") == "histogram":
            name, vector = vectors[0]
            warnings.append("Histogram of entry {!r}.".format(name))
            capture = _histogram_of(np, vector, options, warnings)
            capture.descriptor.python_type = qualified_type(value)
            capture.descriptor.preview = preview(value)
            return capture

        return _build_series(np, value, vectors, common, options, warnings)


def _build_series(
    np: Any,
    original: Any,
    vectors: List[Tuple[str, Any]],
    length: int,
    options: Dict[str, Any],
    warnings: List[str],
) -> Capture:
    max_points = int(options.get("maxPoints") or builtins_.DEFAULT_MAX_POINTS)

    # One decimation decision for every entry, as for a DataFrame: entries
    # decimated separately would land on different x positions, and comparing
    # series sampled at different places defeats the reason to overlay them.
    positions, method = _shared_decimation(np, vectors[0][1], max_points)

    builder = PayloadBuilder()
    if positions is not None:
        builder.add("x", "x", "i64", _pack_positions(np, positions), len(positions))

    columns: List[ColumnInfo] = []
    overall: Optional[NumericStats] = None

    for name, vector in vectors:
        stats = _stats_of(np, vector)
        overall = overall or stats
        shown = vector if positions is None else _take(np, vector, positions)
        builder.add(name, "y", "f64", _pack_values(np, shown), len(shown), stats)
        columns.append(ColumnInfo(name=name, dtype="float64", numeric=True, channel=name, stats=stats))

    descriptor = Descriptor(
        kind="mapping",
        python_type=qualified_type(original),
        preview=preview(original),
        shape=[length, len(vectors)],
        dtype=None,
        nbytes=None,
        stats=overall,
        columns=columns,
        channels=builder.channels,
        decimation=(
            None
            if positions is None
            else Decimation(
                method=method or "stride", original_length=length, output_length=len(positions)
            )
        ),
        suggested_viz=["line", "grid", "scatter", "histogram"],
    )
    return Capture(descriptor=descriptor, payload=builder.build(), warnings=warnings)


# --------------------------------------------------------------------------- #
# numpy when it is there, plain Python when it is not
# --------------------------------------------------------------------------- #


def _as_vector(np: Any, item: Any) -> Optional[Any]:
    """A flat run of numbers, or None if this entry is not one."""
    if np is not None and isinstance(item, np.ndarray):
        if item.ndim != 1 or item.dtype.kind not in ("f", "i", "u", "b"):
            return None
        return item
    if isinstance(item, (list, tuple, range)):
        if len(item) > builtins_.MAX_SCAN:
            item = list(item[: builtins_.MAX_SCAN])
        numbers = builtins_._as_floats(item)
        return numbers
    return None


def _shared_decimation(np: Any, reference: Any, max_points: int) -> Tuple[Optional[Any], Optional[str]]:
    if np is not None and isinstance(reference, np.ndarray):
        return numpy_.decimate_indices(np, reference, max_points)
    if len(reference) <= max_points:
        return None, None
    step = math.ceil(len(reference) / max_points)
    return list(range(0, len(reference), step)), "stride"


def _take(np: Any, vector: Any, positions: Any) -> Any:
    if np is not None and isinstance(vector, np.ndarray):
        return vector[positions]
    return [vector[index] for index in positions]


def _stats_of(np: Any, vector: Any) -> NumericStats:
    if np is not None and isinstance(vector, np.ndarray):
        return numpy_.numeric_stats(np, vector)
    return builtins_._stats_of(vector)


def _pack_positions(np: Any, positions: Any) -> bytes:
    if np is not None and not isinstance(positions, list):
        return numpy_._to_wire(np, positions, "i64", np.int64)
    return builtins_._pack("q", positions)


def _pack_values(np: Any, values: Any) -> bytes:
    if np is not None and isinstance(values, np.ndarray):
        return numpy_._to_wire(np, values, "f64", np.float64)
    return builtins_._pack("d", values)


def _histogram_of(np: Any, vector: Any, options: Dict[str, Any], warnings: List[str]) -> Capture:
    if np is not None and isinstance(vector, np.ndarray):
        return numpy_._build_histogram(np, vector, options, warnings)
    return builtins_._build_histogram(vector, list(vector), builtins_._stats_of(vector), options, warnings)


def _describe_only(value: Any, warnings: List[str]) -> Capture:
    descriptor = Descriptor(
        kind="mapping",
        python_type=qualified_type(value),
        preview=preview(value),
        shape=[len(value)],
        channels=[],
        suggested_viz=["tree"],
    )
    return Capture(descriptor=descriptor, warnings=warnings)


def install(registry: Registry) -> None:
    registry.register(MappingAdapter())
