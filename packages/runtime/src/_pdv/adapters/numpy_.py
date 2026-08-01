"""NumPy adapter.

Note that ``numpy`` is imported from ``sys.modules`` rather than by a plain
``import numpy``. The registry only materialises this adapter once the debuggee
has imported numpy itself, and this keeps that guarantee honest even if the
module is used directly.
"""

from __future__ import annotations

import math
import sys
from typing import Any, Dict, List, Optional, Tuple

from .. import window as window_mod
from ..codec import PayloadBuilder, preview, qualified_type
from ..descriptor import Capture, Decimation, Descriptor, NumericStats, WindowInfo
from ..errors import CaptureError
from ..registry import Adapter, Registry

#: Points transferred per channel before decimation kicks in. A 4K display is
#: ~4000 pixels wide, so this is already several points per pixel; the limit
#: exists to keep the inline transport cheap, not to keep the plot readable.
DEFAULT_MAX_POINTS = 20_000

#: Elements transferred for a 2-D heatmap before striding. 1024x1024 is well
#: beyond what any panel can resolve.
DEFAULT_MAX_CELLS = 1024 * 1024

#: At or below this many columns, a tall 2-D array reads as a set of series
#: rather than as an image. Matches the webview's palette size, since that is
#: how many lines it can tell apart.
NARROW_MATRIX_COLUMNS = 8

_INT_WIRE = {1: "i8", 2: "i16", 4: "i32", 8: "i64"}
_UINT_WIRE = {1: "u8", 2: "u16", 4: "u32", 8: "u64"}
_SUPPORTED_TIME_UNITS = ("s", "ms", "us", "ns")


def _numpy() -> Any:
    np = sys.modules.get("numpy")
    if np is None:  # pragma: no cover - the registry gates on this
        raise CaptureError("NumpyMissing", "numpy is not imported in this process.")
    return np


class NumpyAdapter(Adapter):
    name = "numpy.ndarray"

    def score(self, value: Any) -> int:
        np = sys.modules.get("numpy")
        if np is None:
            return 0
        # Exclude subclasses that other adapters own more precisely (np.matrix is
        # fine here, but pandas' arrays and masked arrays are not).
        if isinstance(value, np.ndarray) and not isinstance(value, np.ma.MaskedArray):
            return 80
        if isinstance(value, np.generic):
            return 60
        return 0

    def build(self, value: Any, options: Dict[str, Any]) -> Capture:
        np = _numpy()
        if isinstance(value, np.generic):
            return _build_numpy_scalar(np, value)

        arr = value
        warnings: List[str] = []

        wire_dtype, cast_to, time_unit = _map_dtype(np, arr.dtype)
        if wire_dtype is None:
            return _describe_only(
                np,
                arr,
                warnings=[
                    "dtype {} cannot be plotted directly. {}".format(arr.dtype, _dtype_hint(arr.dtype))
                ],
                suggested=["tree"],
            )

        # A histogram is a reduction, so it is computed here rather than in the
        # webview: the alternative is shipping ten million points across the
        # wire to draw a hundred bars.
        if options.get("viz") == "histogram":
            return _build_histogram(np, arr, options, warnings)

        if arr.ndim == 1:
            return _build_1d(np, arr, wire_dtype, cast_to, time_unit, options, warnings)
        if arr.ndim == 2:
            return _build_2d(np, arr, wire_dtype, cast_to, options, warnings)
        if arr.ndim == 3 and arr.shape[2] in (3, 4):
            return _build_image(np, arr, options, warnings)
        return _describe_only(
            np,
            arr,
            warnings=[
                "{}-dimensional arrays of shape {} are not plotted. Slice down to 1-D or 2-D, "
                "for example x[0] or x[:, :, 0].".format(arr.ndim, tuple(int(d) for d in arr.shape))
            ],
            suggested=["tree"],
        )


# --------------------------------------------------------------------------- #
# dtype mapping
# --------------------------------------------------------------------------- #


def _map_dtype(np: Any, dtype: Any) -> Tuple[Optional[str], Any, Optional[str]]:
    """Map a numpy dtype to (wire dtype, cast target, time unit).

    A ``None`` wire dtype means "cannot be transferred as numbers"; the caller
    still emits a descriptor so the user sees shape and type.
    """
    kind = dtype.kind
    size = dtype.itemsize

    if kind == "f":
        # float16 has no JS equivalent, so it widens to f32 rather than failing.
        return ("f32", np.float32, None) if size <= 4 else ("f64", np.float64, None)
    if kind == "i":
        return _INT_WIRE.get(size), dtype, None
    if kind == "u":
        return _UINT_WIRE.get(size), dtype, None
    if kind == "b":
        return "bool", np.uint8, None
    if kind == "M":
        unit = _time_unit_of(dtype)
        if unit in _SUPPORTED_TIME_UNITS:
            return "i64", None, unit
        # Coarser units (days, months, years) have no direct millisecond
        # representation, so normalise rather than inventing one.
        return "i64", np.dtype("datetime64[ms]"), "ms"
    return None, None, None


def _time_unit_of(dtype: Any) -> Optional[str]:
    text = str(dtype)
    start, end = text.find("["), text.find("]")
    return text[start + 1 : end] if 0 <= start < end else None


def _dtype_hint(dtype: Any) -> str:
    kind = dtype.kind
    if kind == "c":
        return "Try np.abs(x), x.real or x.imag."
    if kind == "O":
        return "Object arrays hold arbitrary Python objects; convert with x.astype(float) if they are numeric."
    if kind in ("U", "S"):
        return "String arrays can be counted, e.g. np.unique(x, return_counts=True)."
    return ""


# --------------------------------------------------------------------------- #
# statistics
# --------------------------------------------------------------------------- #


def numeric_stats(np: Any, arr: Any) -> NumericStats:
    """Statistics over every element, including the ones decimation will drop."""
    flat = arr.reshape(-1)
    count = int(flat.size)
    if count == 0:
        return NumericStats(count=0)

    nan_count = 0
    inf_count = 0
    finite = flat

    if flat.dtype.kind == "f":
        finite_mask = np.isfinite(flat)
        non_finite = count - int(finite_mask.sum())
        if non_finite:
            nan_count = int(np.isnan(flat).sum())
            inf_count = non_finite - nan_count
            finite = flat[finite_mask]

    if finite.size == 0:
        return NumericStats(count=count, nan_count=nan_count, inf_count=inf_count)

    return NumericStats(
        count=count,
        min=float(finite.min()),
        max=float(finite.max()),
        mean=float(finite.mean()),
        std=float(finite.std()),
        nan_count=nan_count,
        inf_count=inf_count,
    )


# --------------------------------------------------------------------------- #
# decimation
# --------------------------------------------------------------------------- #


def decimate_indices(np: Any, y: Any, target: int) -> Tuple[Optional[Any], Optional[str]]:
    """Choose indices to keep, and report which method produced them.

    Two methods, picked by the data rather than by configuration:

    - **LTTB** for clean data. It preserves the visual shape of a line far
      better than striding at the same point count.
    - **min/max** when NaN or Inf are present. LTTB's triangle areas are
      undefined around non-finite values, and more importantly it would quietly
      drop the gaps — making a series with holes in it look continuous. min/max
      keeps at least one non-finite sample per bucket, so the gap stays on
      screen where the user can see it.
    """
    n = int(y.size)
    if target <= 2 or n <= target:
        return None, None
    if y.dtype.kind == "f" and not bool(np.isfinite(y).all()):
        return _minmax_indices(np, y, target), "minmax"
    return _lttb_indices(np, y, target), "lttb"


def _minmax_indices(np: Any, y: Any, target: int) -> Any:
    n = int(y.size)
    buckets = max(1, target // 3)
    edges = np.linspace(0, n, buckets + 1).astype(np.int64)
    keep: List[int] = [0, n - 1]

    for b in range(buckets):
        start, end = int(edges[b]), int(edges[b + 1])
        if start >= end:
            continue
        segment = y[start:end]
        finite_mask = np.isfinite(segment)
        if not bool(finite_mask.all()):
            keep.append(start + int(np.argmin(finite_mask)))  # first non-finite
        finite_idx = np.flatnonzero(finite_mask)
        if finite_idx.size == 0:
            continue
        finite_vals = segment[finite_idx]
        keep.append(start + int(finite_idx[int(np.argmin(finite_vals))]))
        keep.append(start + int(finite_idx[int(np.argmax(finite_vals))]))

    return np.unique(np.array(keep, dtype=np.int64))


def _lttb_indices(np: Any, y: Any, target: int) -> Any:
    """Largest-Triangle-Three-Buckets over (position, value)."""
    n = int(y.size)
    values = y.astype(np.float64, copy=False)
    positions = np.arange(n, dtype=np.float64)

    out = np.empty(target, dtype=np.int64)
    out[0] = 0
    out[-1] = n - 1
    bucket_size = (n - 2) / (target - 2)
    anchor = 0

    for i in range(target - 2):
        start = int((i + 1) * bucket_size) + 1
        end = min(int((i + 2) * bucket_size) + 1, n - 1)
        next_start, next_end = end, min(int((i + 3) * bucket_size) + 1, n)

        if next_start >= next_end:
            avg_x, avg_y = positions[n - 1], values[n - 1]
        else:
            avg_x = positions[next_start:next_end].mean()
            avg_y = values[next_start:next_end].mean()

        if start >= end:
            out[i + 1] = anchor
            continue

        ax, ay = positions[anchor], values[anchor]
        area = np.abs(
            (ax - avg_x) * (values[start:end] - ay) - (ax - positions[start:end]) * (avg_y - ay)
        )
        anchor = start + int(np.argmax(area))
        out[i + 1] = anchor

    return np.unique(out)


# --------------------------------------------------------------------------- #
# builders
# --------------------------------------------------------------------------- #


def _to_wire(np: Any, arr: Any, wire_dtype: str, cast_to: Any) -> bytes:
    """Convert to the wire dtype and return little-endian contiguous bytes."""
    if cast_to is None:  # datetime64 in a directly supported unit
        arr = arr.view(np.int64)
    elif arr.dtype != cast_to:
        arr = arr.astype(cast_to, copy=False)

    if wire_dtype == "bool":
        arr = arr.view(np.uint8) if arr.dtype == np.bool_ else arr.astype(np.uint8, copy=False)

    if arr.dtype.byteorder == ">":
        arr = arr.astype(arr.dtype.newbyteorder("<"), copy=False)
    return np.ascontiguousarray(arr).tobytes()


def _build_1d(
    np: Any,
    arr: Any,
    wire_dtype: str,
    cast_to: Any,
    time_unit: Optional[str],
    options: Dict[str, Any],
    warnings: List[str],
) -> Capture:
    # Over the complete value, and computed before anything is cropped or
    # dropped. This number is the one the stats strip shows, and its worth
    # rests entirely on never moving with the view.
    stats = numeric_stats(np, arr)
    max_points = int(options.get("maxPoints") or DEFAULT_MAX_POINTS)

    axis = explicit_axis(np, arr.size, options, warnings)
    crop = window_mod.plan(np, axis, int(arr.size), options)
    values, axis_values, window = crop.apply(arr), crop.axis, crop.window

    indices, method = decimate_indices(np, values, max_points)
    shown = values if indices is None else values[indices]
    shown_axis = None if axis_values is None else (
        axis_values if indices is None else axis_values[indices]
    )

    builder = PayloadBuilder()
    # Positions travel whenever they are no longer the implicit 0..n-1: an
    # explicit axis, a window that starts somewhere other than zero, or
    # decimation having removed some of them.
    if shown_axis is not None:
        builder.add("x", "x", "f64", _to_wire(np, shown_axis, "f64", np.float64), int(shown_axis.size))
    elif indices is not None:
        builder.add("x", "x", "i64", _to_wire(np, indices, "i64", np.int64), int(indices.size))

    builder.add(
        "y", "y", wire_dtype, _to_wire(np, shown, wire_dtype, cast_to), int(shown.size), stats
    )

    descriptor = Descriptor(
        kind="ndarray",
        python_type=qualified_type(arr),
        preview=preview(arr),
        shape=list(arr.shape),
        dtype=str(arr.dtype),
        nbytes=int(arr.nbytes),
        stats=stats,
        index=None,
        columns=None,
        channels=builder.channels,
        decimation=(
            None
            if indices is None
            else Decimation(
                method=method or "stride",
                original_length=int(values.size),
                output_length=int(shown.size),
            )
        ),
        window=(
            None
            if window is None
            else WindowInfo(low=window.low, high=window.high, stats=numeric_stats(np, values))
        ),
        truncated=False,
        suggested_viz=["line", "histogram", "scatter"] if time_unit is None else ["line"],
    )
    return Capture(descriptor=descriptor, payload=builder.build(), warnings=warnings)


def explicit_axis(np: Any, length: int, options: Dict[str, Any], warnings: List[str]) -> Any:
    """A user-supplied horizontal axis, or None to use positions.

    A mismatched length is reported and ignored rather than being truncated or
    padded to fit: pairing the wrong x with the wrong y produces a plot that is
    wrong in a way nobody can see.
    """
    supplied = options.get("_x")
    if supplied is None:
        return None

    vector = _as_axis(np, supplied)
    if vector is None:
        warnings.append("The x expression is not a flat sequence of numbers; using positions.")
        return None
    if vector.size != length:
        warnings.append(
            "The x expression has {:,} values but the data has {:,}; using positions.".format(
                vector.size, length
            )
        )
        return None
    return vector


def _as_axis(np: Any, value: Any) -> Any:
    """Anything array-like and numeric, as float64."""
    if hasattr(value, "to_numpy"):  # pandas Series or Index
        value = value.to_numpy()
    if isinstance(value, np.ndarray):
        if value.ndim != 1:
            return None
        if value.dtype.kind == "M":
            return value.astype("datetime64[ms]").view(np.int64).astype(np.float64)
        if value.dtype.kind not in ("f", "i", "u", "b"):
            return None
        return value.astype(np.float64, copy=False)
    if isinstance(value, (list, tuple, range)):
        numbers = window_mod.as_float_list(list(value))
        return None if numbers is None else np.asarray(numbers, dtype=np.float64)
    return None


def _build_2d(
    np: Any,
    arr: Any,
    wire_dtype: str,
    cast_to: Any,
    options: Dict[str, Any],
    warnings: List[str],
) -> Capture:
    stats = numeric_stats(np, arr)
    max_cells = int(options.get("maxCells") or DEFAULT_MAX_CELLS)

    rows, cols = int(arr.shape[0]), int(arr.shape[1])
    view = arr
    truncated = False
    if rows * cols > max_cells:
        # Stride rather than average: an averaged heatmap hides exactly the
        # single-pixel outliers people open a debugger to find.
        row_step = col_step = max(1, int(math.ceil(((rows * cols) / max_cells) ** 0.5)))
        view = arr[::row_step, ::col_step]
        truncated = True
        warnings.append(
            "Showing every {}. row and {}. column ({}x{} of {}x{}).".format(
                row_step, col_step, view.shape[0], view.shape[1], rows, cols
            )
        )

    builder = PayloadBuilder()
    builder.add(
        "value",
        "value",
        wire_dtype,
        _to_wire(np, view, wire_dtype, cast_to),
        int(view.size),
        stats,
    )

    descriptor = Descriptor(
        kind="ndarray",
        python_type=qualified_type(arr),
        preview=preview(arr),
        shape=[int(view.shape[0]), int(view.shape[1])],
        dtype=str(arr.dtype),
        nbytes=int(arr.nbytes),
        stats=stats,
        index=None,
        columns=None,
        channels=builder.channels,
        decimation=None,
        truncated=truncated,
        # A few columns of many rows is `column_stack`, not a picture: as a
        # heatmap it is a two-pixel-wide smear, so lines are the useful default.
        # A genuinely wide matrix stays a heatmap.
        suggested_viz=(
            ["line", "grid", "heatmap", "histogram"]
            if cols <= NARROW_MATRIX_COLUMNS and rows > cols
            else ["heatmap", "grid", "histogram"]
        ),
    )
    return Capture(descriptor=descriptor, payload=builder.build(), warnings=warnings)


#: Bounds on automatic bin counts. Below 1 there is no histogram; above a few
#: hundred the bars are thinner than a pixel and the picture is just noise.
MIN_BINS = 1
MAX_BINS = 512


def _build_histogram(np: Any, arr: Any, options: Dict[str, Any], warnings: List[str]) -> Capture:
    flat = arr.reshape(-1)
    stats = numeric_stats(np, flat)

    finite = flat[np.isfinite(flat)] if flat.dtype.kind == "f" else flat
    if finite.size == 0:
        warnings.append("No finite values to bin.")
        return _describe_only(np, arr, warnings=warnings, suggested=["scalar"])

    if stats.nan_count or stats.inf_count:
        # Said out loud because the bar heights would otherwise imply every
        # element is accounted for somewhere in the chart.
        warnings.append(
            "{:,} non-finite values are excluded from the bins but counted in the statistics.".format(
                stats.nan_count + stats.inf_count
            )
        )

    bins = options.get("bins")
    bins = _auto_bin_count(np, finite) if not bins else max(MIN_BINS, min(int(bins), MAX_BINS))

    counts, edges = np.histogram(finite, bins=bins)

    builder = PayloadBuilder()
    builder.add(
        "binEdge", "binEdge", "f64", _to_wire(np, edges, "f64", np.float64), int(edges.size)
    )
    builder.add(
        "binCount", "binCount", "i64", _to_wire(np, counts, "i64", np.int64), int(counts.size)
    )

    descriptor = Descriptor(
        kind="ndarray",
        python_type=qualified_type(arr),
        preview=preview(arr),
        shape=list(arr.shape),
        dtype=str(arr.dtype),
        nbytes=int(arr.nbytes),
        stats=stats,
        channels=builder.channels,
        suggested_viz=["histogram"],
    )
    return Capture(descriptor=descriptor, payload=builder.build(), warnings=warnings)


def _auto_bin_count(np: Any, values: Any) -> int:
    """Freedman-Diaconis, which adapts to spread instead of assuming normality.

    Falls back to Sturges when the interquartile range collapses, which happens
    with heavily repeated values -- a boolean mask cast to float, say.
    """
    n = int(values.size)
    if n < 2:
        return MIN_BINS

    q75, q25 = np.percentile(values.astype(np.float64, copy=False), [75, 25])
    iqr = float(q75 - q25)
    spread = float(values.max()) - float(values.min())
    if spread <= 0:
        return MIN_BINS

    if iqr > 0:
        width = 2.0 * iqr / (n ** (1.0 / 3.0))
        count = int(math.ceil(spread / width)) if width > 0 else 0
    else:
        count = int(math.ceil(math.log2(n))) + 1

    return max(MIN_BINS, min(count, MAX_BINS))


#: Pixels transferred for an image before striding. Larger than the 2-D cell cap
#: because three or four bytes per pixel still fits comfortably.
DEFAULT_MAX_PIXELS = 2048 * 2048


def _build_image(np: Any, arr: Any, options: Dict[str, Any], warnings: List[str]) -> Capture:
    """An H×W×3 or H×W×4 array as a picture.

    Channel values are normalised to bytes following the convention every
    imaging library in Python shares: integer arrays are already 0-255, float
    arrays are 0-1. Guessing from the observed range instead would make an image
    that happens to be dark look correctly exposed, which is precisely the bug
    someone would be opening the debugger to find.
    """
    rows, cols, channels = (int(d) for d in arr.shape)
    max_pixels = int(options.get("maxPixels") or DEFAULT_MAX_PIXELS)

    view = arr
    truncated = False
    if rows * cols > max_pixels:
        step = max(1, int(math.ceil(((rows * cols) / max_pixels) ** 0.5)))
        view = arr[::step, ::step]
        truncated = True
        warnings.append(
            "Showing every {}. pixel ({}x{} of {}x{}).".format(
                step, view.shape[0], view.shape[1], rows, cols
            )
        )

    if view.dtype.kind == "f":
        low, high = float(np.nanmin(view)), float(np.nanmax(view))
        if low < -0.01 or high > 1.01:
            warnings.append(
                "Float images are read as 0-1; values here run {:.3g} to {:.3g} and are "
                "clipped.".format(low, high)
            )
        as_bytes = np.clip(np.nan_to_num(view, nan=0.0) * 255.0, 0, 255).astype(np.uint8)
    elif view.dtype == np.uint8:
        as_bytes = view
    else:
        as_bytes = np.clip(view, 0, 255).astype(np.uint8)

    builder = PayloadBuilder()
    builder.add(
        "pixel",
        "value",
        "u8",
        np.ascontiguousarray(as_bytes).tobytes(),
        int(as_bytes.size),
        numeric_stats(np, arr),
    )

    descriptor = Descriptor(
        kind="ndarray",
        python_type=qualified_type(arr),
        preview=preview(arr),
        # The transferred shape, not the original: the renderer lays pixels out
        # from this, and reporting the original would tear the image.
        shape=[int(view.shape[0]), int(view.shape[1]), channels],
        dtype=str(arr.dtype),
        nbytes=int(arr.nbytes),
        stats=numeric_stats(np, arr),
        channels=builder.channels,
        truncated=truncated,
        suggested_viz=["image", "histogram"],
    )
    return Capture(descriptor=descriptor, payload=builder.build(), warnings=warnings)


def _build_numpy_scalar(np: Any, value: Any) -> Capture:
    as_float: Optional[float] = None
    try:
        as_float = float(value)
    except (TypeError, ValueError):
        pass

    stats = (
        NumericStats(count=1, min=as_float, max=as_float, mean=as_float, std=0.0)
        if as_float is not None
        else None
    )
    descriptor = Descriptor(
        kind="scalar",
        python_type=qualified_type(value),
        preview=preview(value),
        shape=[],
        dtype=str(value.dtype),
        nbytes=int(value.itemsize),
        stats=stats,
        channels=[],
        suggested_viz=["scalar"],
    )
    return Capture(descriptor=descriptor)


def _describe_only(np: Any, arr: Any, warnings: List[str], suggested: List[str]) -> Capture:
    """Emit metadata without a payload.

    Used whenever we cannot plot a value but can still say something useful
    about it. Showing shape, dtype and — where possible — statistics is far more
    helpful than an error message, and it is the difference between "this tool
    is broken" and "this tool told me what I have".
    """
    stats = None
    if arr.dtype.kind in ("f", "i", "u", "b"):
        try:
            stats = numeric_stats(np, arr)
        except Exception:
            stats = None

    descriptor = Descriptor(
        kind="ndarray",
        python_type=qualified_type(arr),
        preview=preview(arr),
        shape=list(arr.shape),
        dtype=str(arr.dtype),
        nbytes=int(arr.nbytes),
        stats=stats,
        channels=[],
        truncated=True,
        suggested_viz=suggested,
    )
    return Capture(descriptor=descriptor, warnings=warnings)


def install(registry: Registry) -> None:
    registry.register(NumpyAdapter())
