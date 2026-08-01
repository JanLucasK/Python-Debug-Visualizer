"""Adapters for values that need no third-party library.

These matter more than they look. A debuggee that has not imported numpy still
produces lists of floats, and a tool that only works once numpy is loaded fails
exactly when someone is debugging plain Python.
"""

from __future__ import annotations

import array as _array
import math
import sys as _sys
from typing import Any, Dict, List, Optional, Sequence

from .. import window as window_mod
from ..codec import PayloadBuilder, preview, qualified_type
from ..descriptor import Capture, Decimation, Descriptor, NumericStats, WindowInfo
from ..registry import Adapter, Registry

__all__ = ["ScalarAdapter", "SequenceAdapter", "FallbackAdapter", "install"]

#: Elements scanned before we stop and report a truncated view. Pure-Python
#: iteration is roughly a hundred times slower than numpy, and a debugger that
#: freezes for ten seconds is not usable.
MAX_SCAN = 200_000
DEFAULT_MAX_POINTS = 20_000

#: Above a few hundred bins the bars are thinner than a pixel.
MAX_BINS = 512

_BOOL_INT_FLOAT = (bool, int, float)


class ScalarAdapter(Adapter):
    name = "builtins.scalar"

    def score(self, value: Any) -> int:
        if value is None or isinstance(value, (bool, int, float, complex, str, bytes)):
            return 30
        return 0

    def build(self, value: Any, options: Dict[str, Any]) -> Capture:
        stats: Optional[NumericStats] = None
        if isinstance(value, _BOOL_INT_FLOAT) and not isinstance(value, bool):
            number = float(value)
            stats = NumericStats(
                count=1,
                min=number,
                max=number,
                mean=number,
                std=0.0,
                nan_count=1 if math.isnan(number) else 0,
                inf_count=1 if math.isinf(number) else 0,
            )
        descriptor = Descriptor(
            kind="scalar",
            python_type=qualified_type(value),
            preview=preview(value),
            shape=[],
            dtype=type(value).__name__,
            stats=stats,
            channels=[],
            suggested_viz=["scalar"],
        )
        return Capture(descriptor=descriptor)


class SequenceAdapter(Adapter):
    """Flat sequences of numbers: list, tuple, range and array.array."""

    name = "builtins.sequence"

    def score(self, value: Any) -> int:
        if isinstance(value, (list, tuple, range, _array.array)):
            return 30
        return 0

    def build(self, value: Any, options: Dict[str, Any]) -> Capture:
        warnings: List[str] = []
        length = len(value)

        scanned: Sequence[Any] = value
        truncated = False
        if length > MAX_SCAN:
            scanned = list(value[:MAX_SCAN])
            truncated = True
            warnings.append(
                "Scanned the first {:,} of {:,} elements. Convert to a NumPy array "
                "for the full view.".format(MAX_SCAN, length)
            )

        numbers = _as_floats(scanned)
        if numbers is None:
            descriptor = Descriptor(
                kind="sequence",
                python_type=qualified_type(value),
                preview=preview(value),
                shape=[length],
                dtype=None,
                stats=None,
                channels=[],
                truncated=truncated,
                suggested_viz=["tree"],
            )
            warnings.append("Sequence contains non-numeric elements; showing structure instead.")
            return Capture(descriptor=descriptor, warnings=warnings)

        if options.get("viz") == "histogram":
            return _build_histogram(value, numbers, _stats_of(numbers), options, warnings)

        # Statistics describe the whole sequence, computed before the crop.
        stats = _stats_of(numbers)
        max_points = int(options.get("maxPoints") or DEFAULT_MAX_POINTS)

        crop = window_mod.plan(None, None, len(numbers), options)
        shown_numbers = crop.apply(numbers)

        builder = PayloadBuilder()
        if len(shown_numbers) > max_points:
            step = math.ceil(len(shown_numbers) / max_points)
            kept_idx = [crop.axis[i] if crop.axis else i for i in range(0, len(shown_numbers), step)]
            kept = [shown_numbers[i] for i in range(0, len(shown_numbers), step)]
            builder.add("x", "x", "i64", _pack("q", [int(i) for i in kept_idx]), len(kept_idx))
            builder.add("y", "y", "f64", _pack("d", kept), len(kept), stats)
            decimation: Optional[Decimation] = Decimation(
                method="stride", original_length=len(shown_numbers), output_length=len(kept)
            )
        else:
            if crop.window is not None and crop.axis is not None:
                builder.add("x", "x", "i64", _pack("q", [int(i) for i in crop.axis]), len(crop.axis))
            builder.add("y", "y", "f64", _pack("d", shown_numbers), len(shown_numbers), stats)
            decimation = None

        descriptor = Descriptor(
            kind="sequence",
            python_type=qualified_type(value),
            preview=preview(value),
            shape=[length],
            dtype="float64",
            nbytes=None,
            stats=stats,
            channels=builder.channels,
            decimation=decimation,
            window=(
                None
                if crop.window is None
                else WindowInfo(
                    low=crop.window.low, high=crop.window.high, stats=_stats_of(shown_numbers)
                )
            ),
            truncated=truncated,
            suggested_viz=["line", "histogram", "scatter"],
        )
        return Capture(descriptor=descriptor, payload=builder.build(), warnings=warnings)


class FallbackAdapter(Adapter):
    """Last resort: describe anything at all, without ever failing."""

    name = "fallback"

    def score(self, value: Any) -> int:
        return 1

    def build(self, value: Any, options: Dict[str, Any]) -> Capture:
        shape = None
        try:
            shape = [len(value)]  # type: ignore[arg-type]
        except Exception:
            pass

        kind = "mapping" if isinstance(value, dict) else "object"
        descriptor = Descriptor(
            kind=kind,
            python_type=qualified_type(value),
            preview=preview(value),
            shape=shape,
            channels=[],
            suggested_viz=["tree"],
        )
        return Capture(descriptor=descriptor)


def _build_histogram(
    value: Any,
    numbers: List[float],
    stats: NumericStats,
    options: Dict[str, Any],
    warnings: List[str],
) -> Capture:
    """Bin a plain Python sequence.

    Duplicated in spirit with the NumPy adapter rather than shared, because the
    two have nothing in common beyond the output shape: this one is a loop, that
    one is a vectorised call. What *is* shared is the wire format, so the
    webview has exactly one histogram renderer.
    """
    finite = [v for v in numbers if v == v and not math.isinf(v)]
    if not finite:
        warnings.append("No finite values to bin.")
        return Capture(
            descriptor=Descriptor(
                kind="sequence",
                python_type=qualified_type(value),
                preview=preview(value),
                shape=[len(numbers)],
                stats=stats,
                channels=[],
                suggested_viz=["scalar"],
            ),
            warnings=warnings,
        )

    if stats.nan_count or stats.inf_count:
        warnings.append(
            "{:,} non-finite values are excluded from the bins but counted in the "
            "statistics.".format(stats.nan_count + stats.inf_count)
        )

    low, high = min(finite), max(finite)
    requested = options.get("bins")
    bin_count = (
        max(1, min(int(requested), MAX_BINS))
        if requested
        else max(1, min(int(math.log2(len(finite))) + 1 if len(finite) > 1 else 1, MAX_BINS))
    )

    if high == low:
        # A degenerate range still deserves a bar rather than a division by zero.
        edges = [low - 0.5, low + 0.5]
        counts = [len(finite)]
    else:
        width = (high - low) / bin_count
        edges = [low + width * i for i in range(bin_count + 1)]
        counts = [0] * bin_count
        for number in finite:
            index = int((number - low) / width)
            counts[min(index, bin_count - 1)] += 1  # the maximum lands in the last bin

    builder = PayloadBuilder()
    builder.add("binEdge", "binEdge", "f64", _pack("d", edges), len(edges))
    builder.add("binCount", "binCount", "i64", _pack("q", counts), len(counts))

    descriptor = Descriptor(
        kind="sequence",
        python_type=qualified_type(value),
        preview=preview(value),
        shape=[len(numbers)],
        dtype="float64",
        stats=stats,
        channels=builder.channels,
        suggested_viz=["histogram"],
    )
    return Capture(descriptor=descriptor, payload=builder.build(), warnings=warnings)


def _as_floats(values: Sequence[Any]) -> Optional[List[float]]:
    """Convert to floats, or give up as soon as an element is not a number.

    ``bool`` is accepted (it is an ``int``) because plotting a boolean mask over
    time is a genuinely useful thing to want.
    """
    out: List[float] = []
    for item in values:
        if isinstance(item, _BOOL_INT_FLOAT):
            out.append(float(item))
        else:
            return None
    return out


def _stats_of(numbers: Sequence[float]) -> NumericStats:
    count = len(numbers)
    if count == 0:
        return NumericStats(count=0)

    nan_count = 0
    inf_count = 0
    finite: List[float] = []
    for number in numbers:
        if number != number:
            nan_count += 1
        elif number in (math.inf, -math.inf):
            inf_count += 1
        else:
            finite.append(number)

    if not finite:
        return NumericStats(count=count, nan_count=nan_count, inf_count=inf_count)

    mean = sum(finite) / len(finite)
    variance = sum((v - mean) ** 2 for v in finite) / len(finite)
    return NumericStats(
        count=count,
        min=min(finite),
        max=max(finite),
        mean=mean,
        std=math.sqrt(variance),
        nan_count=nan_count,
        inf_count=inf_count,
    )


def _pack(fmt: str, values: Sequence[Any]) -> bytes:
    """Pack numbers into little-endian bytes, which is what the wire format assumes."""
    buffer = _array.array(fmt, values)
    if _sys.byteorder != "little":
        buffer.byteswap()
    return buffer.tobytes()


def install(registry: Registry) -> None:
    registry.register(FallbackAdapter())
    registry.register(ScalarAdapter())
    registry.register(SequenceAdapter())
