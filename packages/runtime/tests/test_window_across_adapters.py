"""Every adapter that produces series has to honour the zoom window.

Windowing was implemented in the NumPy 1-D path and nowhere else, so zooming
worked on a single array and silently did nothing on a DataFrame, a dict or a
Series -- the range was sent, ignored, and the full value came back. From the
user's side that is indistinguishable from the zoom being broken.

The failure is invisible per adapter, which is why this is a table rather than a
test per adapter: a new adapter that forgets the crop shows up here.
"""

from __future__ import annotations

import base64
import json

import pytest

from _pdv import envelope
from _pdv import extract as capture_module


def capture(value, **options):
    encoded = (
        base64.b64encode(json.dumps(options).encode("utf-8")).decode("ascii") if options else ""
    )
    return envelope.decode(capture_module.capture(value, encoded))


def series_lengths(document):
    return [c["length"] for c in document["descriptor"]["channels"] if c["role"] == "y"]


@pytest.fixture
def values(np):
    return np.arange(1000.0)


def cases(np, pd):
    """(label, value, expected series count) for everything that draws lines."""
    a = np.arange(1000.0)
    b = a * 2
    entries = [
        ("ndarray", a, 1),
        ("dict of arrays", {"a": a, "b": b}, 2),
        ("dict of lists", {"a": list(a), "b": list(b)}, 2),
        ("list", list(a), 1),
    ]
    if pd is not None:
        entries += [
            ("Series", pd.Series(a, name="a"), 1),
            ("DataFrame", pd.DataFrame({"a": a, "b": b}), 2),
        ]
    return entries


@pytest.fixture
def pd():
    return pytest.importorskip("pandas")


def test_every_series_adapter_crops_to_the_window(np, pd):
    for label, value, expected in cases(np, pd):
        document, _ = capture(value, range=[100, 200])

        assert document["ok"] is True, f"{label}: {document.get('error')}"
        assert document["descriptor"]["window"] is not None, f"{label} ignored the window"

        lengths = series_lengths(document)
        assert len(lengths) == expected, label
        # 100..200 inclusive.
        assert all(length == 101 for length in lengths), f"{label}: {lengths}"


def test_every_series_adapter_reports_the_window_bounds(np, pd):
    for label, value, _ in cases(np, pd):
        window = capture(value, range=[100, 200])[0]["descriptor"]["window"]
        assert (window["from"], window["to"]) == (100.0, 200.0), label


def test_statistics_still_describe_the_whole_value(np, pd):
    """The invariant, checked for every adapter rather than only for NumPy."""
    for label, value, _ in cases(np, pd):
        document, _ = capture(value, range=[100, 200])
        assert document["descriptor"]["stats"]["count"] == 1000, label
        assert document["descriptor"]["stats"]["max"] == 1998.0 or (
            document["descriptor"]["stats"]["max"] == 999.0
        ), label


def test_columns_stay_aligned_when_cropped_and_decimated(np, pd):
    """One crop and one decimation for all of them, or they land on different x."""
    a = np.sin(np.linspace(0, 50, 100_000))
    b = np.cos(np.linspace(0, 50, 100_000))

    for label, value in [("dict", {"a": a, "b": b}), ("frame", pd.DataFrame({"a": a, "b": b}))]:
        document, _ = capture(value, range=[10_000, 60_000], maxPoints=1000)
        lengths = {
            c["name"]: c["length"]
            for c in document["descriptor"]["channels"]
            if c["role"] in ("x", "y")
        }
        assert len(set(lengths.values())) == 1, f"{label}: {lengths}"


def test_a_datetime_index_is_cropped_by_timestamp(pd, np):
    """The window arrives in the units the webview received, which for a
    DatetimeIndex is milliseconds -- not row positions."""
    index = pd.date_range("2026-01-01", periods=1000, freq="h")
    frame = pd.DataFrame({"a": np.arange(1000.0), "b": np.arange(1000.0)}, index=index)

    low = int(index[100].value // 10**6)
    high = int(index[200].value // 10**6)

    document, _ = capture(frame, range=[low, high])
    assert series_lengths(document) == [101, 101]


def test_zooming_inside_a_window_spends_the_budget_there(np):
    """Cropping happens before decimation, for multi-series captures too."""
    a = np.sin(np.linspace(0, 200, 1_000_000))
    b = np.cos(np.linspace(0, 200, 1_000_000))

    whole, _ = capture({"a": a, "b": b}, maxPoints=1000)
    zoomed, _ = capture({"a": a, "b": b}, maxPoints=1000, range=[500_000, 501_000])

    assert whole["descriptor"]["decimation"]["originalLength"] == 1_000_000
    assert zoomed["descriptor"]["decimation"]["originalLength"] == 1001


def test_no_window_leaves_captures_untouched(np, pd):
    for label, value, expected in cases(np, pd):
        document, _ = capture(value)
        assert document["descriptor"]["window"] is None, label
        assert series_lengths(document) == [1000] * expected, label


def test_a_narrow_matrix_is_windowed_and_says_so(np):
    """`np.column_stack([a, b])` is drawn as lines, so it must zoom like them.

    The window field is not cosmetic: without it the webview cannot tell that
    the capture it just received *is* the range it asked for, so it asks again,
    and the zoom never settles.
    """
    a = np.arange(5000.0)
    document, _ = capture(np.column_stack([a, a * 2]), range=[1000, 1200])

    assert document["descriptor"]["shape"] == [201, 2]
    assert document["descriptor"]["window"] is not None, "the webview would loop without this"
    assert document["descriptor"]["window"]["from"] == 1000.0

    # Row positions travel, or the lines would restart at zero.
    channels = {c["name"]: c for c in document["descriptor"]["channels"]}
    assert channels["x"]["length"] == 201


def test_an_unwindowed_matrix_carries_no_positions(np):
    a = np.arange(500.0)
    document, _ = capture(np.column_stack([a, a * 2]))

    assert document["descriptor"]["window"] is None
    assert "x" not in {c["name"] for c in document["descriptor"]["channels"]}
