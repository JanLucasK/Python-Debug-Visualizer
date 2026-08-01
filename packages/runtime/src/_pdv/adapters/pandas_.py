"""pandas adapter.

The shape that matters here is the *frame*: several named numeric columns
sharing one index. That maps onto one channel per column plus one channel for
the index, which is exactly what the multi-series line plot consumes — so
plotting three columns of a DataFrame against a DatetimeIndex needs no special
case anywhere downstream.

Like every optional integration, this module is only imported once the debuggee
has imported pandas itself. See :mod:`_pdv.adapters`.
"""

from __future__ import annotations

import sys
from typing import Any, Dict, List, Optional, Tuple

from ..codec import PayloadBuilder, preview, qualified_type
from ..descriptor import Capture, ColumnInfo, Decimation, Descriptor, IndexInfo, NumericStats
from ..registry import Adapter, Registry
from . import numpy_

#: Columns transferred before we stop and say so. A frame with a thousand
#: columns is not something anyone plots; it is something they slice first.
DEFAULT_MAX_COLUMNS = 32


def _pandas() -> Any:
    pd = sys.modules.get("pandas")
    if pd is None:  # pragma: no cover - the registry gates on this
        from ..errors import CaptureError

        raise CaptureError("PandasMissing", "pandas is not imported in this process.")
    return pd


class PandasAdapter(Adapter):
    name = "pandas"

    def score(self, value: Any) -> int:
        pd = sys.modules.get("pandas")
        if pd is None:
            return 0
        if isinstance(value, (pd.DataFrame, pd.Series, pd.Index)):
            # Above the NumPy adapter, which would otherwise claim Series and
            # Index through their array interface and lose the labels.
            return 90
        return 0

    def build(self, value: Any, options: Dict[str, Any]) -> Capture:
        pd = _pandas()
        np = sys.modules.get("numpy")
        if np is None:  # pandas cannot be imported without it, but be explicit
            from ..errors import CaptureError

            raise CaptureError("NumpyMissing", "numpy is not imported in this process.")

        if isinstance(value, pd.DataFrame):
            return _build_frame(pd, np, value, options)
        if isinstance(value, pd.Series):
            return _build_series(pd, np, value, options)
        return _build_index(pd, np, value, options)


# --------------------------------------------------------------------------- #
# index handling
# --------------------------------------------------------------------------- #


def _index_kind(pd: Any, index: Any) -> str:
    if isinstance(index, pd.MultiIndex):
        return "multi"
    if isinstance(index, pd.RangeIndex):
        return "range"
    if isinstance(index, pd.DatetimeIndex):
        return "datetime"
    if isinstance(index, pd.TimedeltaIndex):
        return "timedelta"
    if isinstance(index, pd.CategoricalIndex):
        return "categorical"
    kind = getattr(index.dtype, "kind", "")
    if kind in ("i", "u"):
        return "integer"
    if kind == "f":
        return "float"
    return "other"


def _to_milliseconds(index: Any) -> Any:
    """Datetime or timedelta values as integer milliseconds.

    The resolution has to be read rather than assumed. `asi8` returns the raw
    integers in whatever unit the array happens to use, and that unit is not
    stable across pandas versions -- 3.0 gives `date_range` second resolution
    where 1.x always gave nanoseconds. Hardcoding a divisor puts timestamps off
    by three orders of magnitude on one of them, and the plot still looks
    entirely plausible.

    Milliseconds is the target because it holds anything a debugger displays and
    stays inside JavaScript's exact-integer range for the next quarter million
    years.
    """
    as_unit = getattr(index, "as_unit", None)
    if as_unit is not None:  # pandas >= 2.0
        return as_unit("ms").asi8
    return index.asi8 // 1_000_000  # pandas < 2.0 is nanoseconds, unconditionally


def _index_channel(pd: Any, np: Any, index: Any, positions: Optional[Any]) -> Tuple[Optional[Any], Optional[str]]:
    """Values to send as the x channel, and their time unit.

    Returns ``(None, None)`` for indexes that are not numeric — strings, tuples,
    categories. Those still describe themselves in :class:`IndexInfo`, but the
    plot falls back to positions, because pretending a string index is a number
    line would put the points in an order the data never had.
    """
    selected = index if positions is None else index[positions]
    kind = _index_kind(pd, index)

    if kind in ("datetime", "timedelta"):
        return _to_milliseconds(selected), "ms"
    if kind in ("range", "integer", "float"):
        return np.asarray(selected), None
    return None, None


# --------------------------------------------------------------------------- #
# builders
# --------------------------------------------------------------------------- #


def _build_series(pd: Any, np: Any, series: Any, options: Dict[str, Any]) -> Capture:
    warnings: List[str] = []
    values = series.to_numpy()

    if options.get("viz") == "histogram":
        capture = numpy_._build_histogram(np, np.asarray(values), options, warnings)
        capture.descriptor.python_type = qualified_type(series)
        capture.descriptor.preview = preview(series)
        return capture

    wire_dtype, cast_to, _ = numpy_._map_dtype(np, values.dtype)
    if wire_dtype is None or values.ndim != 1:
        return _describe_only(
            pd,
            series,
            [
                "Series of dtype {} cannot be plotted. {}".format(
                    series.dtype, numpy_._dtype_hint(values.dtype)
                )
            ],
        )

    stats = numpy_.numeric_stats(np, values)
    max_points = int(options.get("maxPoints") or numpy_.DEFAULT_MAX_POINTS)
    positions, method = numpy_.decimate_indices(np, values, max_points)

    shown = values if positions is None else values[positions]
    index_values, time_unit = _index_channel(pd, np, series.index, positions)

    builder = PayloadBuilder()
    if index_values is not None:
        builder.add(
            "x", "x", "i64", numpy_._to_wire(np, index_values, "i64", np.int64), len(index_values)
        )
    elif positions is not None:
        # Non-numeric index plus decimation: positions still have to travel, or
        # the remaining points would be drawn evenly spaced.
        builder.add(
            "x", "x", "i64", numpy_._to_wire(np, positions, "i64", np.int64), int(positions.size)
        )

    label = str(series.name) if series.name is not None else "value"
    builder.add(
        label, "y", wire_dtype, numpy_._to_wire(np, shown, wire_dtype, cast_to), int(shown.size), stats
    )

    descriptor = Descriptor(
        kind="series",
        python_type=qualified_type(series),
        preview=preview(series),
        shape=[int(series.size)],
        dtype=str(series.dtype),
        nbytes=int(series.memory_usage(deep=False)),
        stats=stats,
        index=IndexInfo(
            kind=_index_kind(pd, series.index),
            name=None if series.index.name is None else str(series.index.name),
            dtype=str(series.index.dtype),
            channel="x" if builder.channels and builder.channels[0].name == "x" else None,
            time_unit=time_unit,
        ),
        columns=None,
        channels=builder.channels,
        decimation=(
            None
            if positions is None
            else Decimation(
                method=method or "stride",
                original_length=int(values.size),
                output_length=int(shown.size),
            )
        ),
        suggested_viz=["line", "histogram", "scatter", "grid"],
    )
    return Capture(descriptor=descriptor, payload=builder.build(), warnings=warnings)


def _build_frame(pd: Any, np: Any, frame: Any, options: Dict[str, Any]) -> Capture:
    warnings: List[str] = []

    numeric = [name for name in frame.columns if _is_numeric(np, frame[name])]
    skipped = len(frame.columns) - len(numeric)
    if skipped:
        warnings.append(
            "{} non-numeric column{} skipped.".format(skipped, "" if skipped == 1 else "s")
        )

    if not numeric:
        return _describe_only(pd, frame, warnings + ["No numeric columns to plot."])

    max_columns = int(options.get("maxColumns") or DEFAULT_MAX_COLUMNS)
    shown_names = numeric[:max_columns]
    if len(numeric) > len(shown_names):
        warnings.append(
            "Showing the first {} of {} numeric columns.".format(len(shown_names), len(numeric))
        )

    if options.get("viz") == "histogram":
        # Binning a whole frame would silently merge unrelated units into one
        # distribution, so it bins the first column and says which.
        first = frame[shown_names[0]]
        warnings.append("Histogram of column {!r}.".format(str(shown_names[0])))
        capture = numpy_._build_histogram(np, first.to_numpy(), options, warnings)
        capture.descriptor.python_type = qualified_type(frame)
        capture.descriptor.preview = preview(frame)
        return capture

    # One decimation decision for the whole frame, taken from the column with
    # the most structure to lose. Decimating columns independently would put
    # them on different x positions and make them incomparable -- which is the
    # entire reason to plot them together.
    max_points = int(options.get("maxPoints") or numpy_.DEFAULT_MAX_POINTS)
    reference = frame[shown_names[0]].to_numpy()
    positions, method = numpy_.decimate_indices(np, reference, max_points)

    index_values, time_unit = _index_channel(pd, np, frame.index, positions)

    builder = PayloadBuilder()
    if index_values is not None:
        builder.add(
            "x", "x", "i64", numpy_._to_wire(np, index_values, "i64", np.int64), len(index_values)
        )
    elif positions is not None:
        builder.add(
            "x", "x", "i64", numpy_._to_wire(np, positions, "i64", np.int64), int(positions.size)
        )

    columns: List[ColumnInfo] = []
    overall: Optional[NumericStats] = None

    for name in frame.columns:
        label = str(name)
        if name not in shown_names:
            columns.append(
                ColumnInfo(name=label, dtype=str(frame[name].dtype), numeric=name in numeric)
            )
            continue

        values = frame[name].to_numpy()
        wire_dtype, cast_to, _ = numpy_._map_dtype(np, values.dtype)
        if wire_dtype is None:
            columns.append(ColumnInfo(name=label, dtype=str(frame[name].dtype), numeric=False))
            continue

        stats = numpy_.numeric_stats(np, values)
        overall = stats if overall is None else overall
        shown = values if positions is None else values[positions]
        builder.add(
            label,
            "y",
            wire_dtype,
            numpy_._to_wire(np, shown, wire_dtype, cast_to),
            int(shown.size),
            stats,
        )
        columns.append(
            ColumnInfo(
                name=label, dtype=str(frame[name].dtype), numeric=True, channel=label, stats=stats
            )
        )

    descriptor = Descriptor(
        kind="frame",
        python_type=qualified_type(frame),
        preview=preview(frame),
        shape=[int(frame.shape[0]), int(frame.shape[1])],
        dtype=None,  # a frame has one dtype per column, reported in `columns`
        nbytes=int(frame.memory_usage(deep=False).sum()),
        # Per-column statistics are the meaningful ones; a single min/max across
        # unrelated units would be noise.
        stats=overall,
        index=IndexInfo(
            kind=_index_kind(pd, frame.index),
            name=None if frame.index.name is None else str(frame.index.name),
            dtype=str(frame.index.dtype),
            channel="x" if index_values is not None or positions is not None else None,
            time_unit=time_unit,
        ),
        columns=columns,
        channels=builder.channels,
        decimation=(
            None
            if positions is None
            else Decimation(
                method=method or "stride",
                original_length=int(frame.shape[0]),
                output_length=int(positions.size),
            )
        ),
        truncated=len(numeric) > len(shown_names),
        suggested_viz=["line", "grid", "scatter", "histogram"],
    )
    return Capture(descriptor=descriptor, payload=builder.build(), warnings=warnings)


def _build_index(pd: Any, np: Any, index: Any, options: Dict[str, Any]) -> Capture:
    """An Index on its own, which people inspect to check alignment and gaps."""
    values, time_unit = _index_channel(pd, np, index, None)
    warnings: List[str] = []

    if values is None:
        return _describe_only(pd, index, ["This index holds no numeric values to plot."])

    array = np.asarray(values)
    stats = numpy_.numeric_stats(np, array)

    builder = PayloadBuilder()
    builder.add(
        "value", "y", "i64", numpy_._to_wire(np, array, "i64", np.int64), int(array.size), stats
    )

    descriptor = Descriptor(
        kind="index",
        python_type=qualified_type(index),
        preview=preview(index),
        shape=[int(index.size)],
        dtype=str(index.dtype),
        nbytes=int(index.nbytes),
        stats=stats,
        index=IndexInfo(
            kind=_index_kind(pd, index),
            name=None if index.name is None else str(index.name),
            dtype=str(index.dtype),
            channel=None,
            time_unit=time_unit,
        ),
        channels=builder.channels,
        suggested_viz=["line", "grid"],
    )
    return Capture(descriptor=descriptor, payload=builder.build(), warnings=warnings)


def _is_numeric(np: Any, series: Any) -> bool:
    return getattr(series.dtype, "kind", "O") in ("f", "i", "u", "b")


def _describe_only(pd: Any, value: Any, warnings: List[str]) -> Capture:
    shape = (
        [int(value.shape[0]), int(value.shape[1])]
        if getattr(value, "ndim", 1) == 2
        else [int(value.shape[0])]
    )
    descriptor = Descriptor(
        kind="frame" if getattr(value, "ndim", 1) == 2 else "series",
        python_type=qualified_type(value),
        preview=preview(value),
        shape=shape,
        dtype=None if getattr(value, "ndim", 1) == 2 else str(value.dtype),
        channels=[],
        truncated=True,
        suggested_viz=["tree"],
    )
    return Capture(descriptor=descriptor, warnings=warnings)


def install(registry: Registry) -> None:
    registry.register(PandasAdapter())
