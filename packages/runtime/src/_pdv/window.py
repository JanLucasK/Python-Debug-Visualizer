"""Restricting a capture to a window of the x axis, and supplying that axis.

Two features that turn out to be the same problem: both replace the implicit
0..n-1 horizontal axis with something else, and both have to happen *before*
decimation.

Order matters and is the whole point of doing this in the debuggee. Decimating
first and cropping afterwards would leave a zoomed-in view holding whatever
handful of points survived the reduction of the full series — the view gets
narrower but no more detailed, which is exactly backwards from what zooming is
for. Cropping first means a zoom re-spends the whole point budget inside the
visible range.
"""

from __future__ import annotations

from typing import Any, List, Optional, Sequence, Tuple


class Window:
    """A half-open range on the x axis, in the units the webview received."""

    __slots__ = ("low", "high")

    def __init__(self, low: float, high: float) -> None:
        self.low = low
        self.high = high

    def to_dict(self) -> dict:
        return {"from": float(self.low), "to": float(self.high)}


def requested_window(options: dict) -> Optional[Window]:
    span = options.get("range")
    if not isinstance(span, (list, tuple)) or len(span) != 2:
        return None
    try:
        low, high = float(span[0]), float(span[1])
    except (TypeError, ValueError):
        return None
    if not (low < high):
        return None
    return Window(low, high)


def mask_for(np: Any, axis: Any, window: Window) -> Any:
    """Boolean mask selecting the axis values inside the window.

    Endpoints are inclusive: a zoom that lands exactly on a sample should show
    it rather than clip it off the edge of the plot.
    """
    return (axis >= window.low) & (axis <= window.high)


def slice_positions(length: int, window: Window) -> Tuple[int, int]:
    """Index bounds for a window given in positions, clamped to the array."""
    low = max(0, int(window.low))
    high = min(length, int(window.high) + 1)
    return low, max(low, high)


def as_float_list(values: Sequence[Any]) -> Optional[List[float]]:
    """Numbers from an arbitrary sequence, or None if any element is not one."""
    out: List[float] = []
    for item in values:
        if isinstance(item, (bool, int, float)):
            out.append(float(item))
        else:
            return None
    return out


class Crop:
    """How to cut every series of one capture down to the same window.

    One plan shared by all of them, for the same reason they share one
    decimation: series cropped independently would end up on different x
    positions, and comparing series sampled at different places is the failure
    that overlaying them is supposed to prevent.
    """

    __slots__ = ("selector", "axis", "window")

    def __init__(self, selector: Any, axis: Any, window: Optional[Window]) -> None:
        #: None, a slice, or an index/mask array. Applied to every series.
        self.selector = selector
        #: The x values after cropping, or None when positions are still implicit.
        self.axis = axis
        self.window = window

    def apply(self, values: Any) -> Any:
        if self.selector is None:
            return values
        if isinstance(self.selector, slice):
            return values[self.selector]
        if isinstance(values, list):
            return [values[i] for i in self.selector]
        return values[self.selector]


def plan(np: Any, axis: Any, length: int, options: dict) -> Crop:
    """Work out the crop for a capture, before anything is decimated.

    Order is the point: cropping after decimation leaves a zoomed view holding
    whatever survived the reduction of the whole series -- narrower, but no more
    detailed.
    """
    window = requested_window(options)
    if window is None:
        return Crop(None, axis, None)

    if axis is None:
        low, high = slice_positions(length, window)
        rebuilt = (
            np.arange(low, high, dtype="float64")
            if np is not None
            else list(range(low, high))
        )
        return Crop(slice(low, high), rebuilt, window)

    if np is not None and hasattr(axis, "dtype"):
        mask = mask_for(np, axis, window)
        return Crop(mask, axis[mask], window)

    kept = [i for i, value in enumerate(axis) if window.low <= value <= window.high]
    return Crop(kept, [axis[i] for i in kept], window)
