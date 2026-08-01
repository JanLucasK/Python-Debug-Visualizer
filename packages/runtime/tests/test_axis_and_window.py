"""The x axis and the zoom window: both replace the implicit 0..n-1 positions."""

from __future__ import annotations

import base64
import json
import struct

import pytest

from _pdv import envelope
from _pdv import extract as capture_module


def capture(value, x=None, **options):
    encoded = (
        base64.b64encode(json.dumps(options).encode("utf-8")).decode("ascii") if options else ""
    )
    raw = (
        capture_module.capture(value, encoded)
        if x is None
        else capture_module.capture(value, encoded, x)
    )
    return envelope.decode(raw)


def channels(document):
    return {c["name"]: c for c in document["descriptor"]["channels"]}


def read(document, payload, name):
    meta = channels(document)[name]
    fmt = {"f32": "f", "f64": "d", "i64": "q", "bool": "B"}[meta["dtype"]]
    raw = payload[meta["byteOffset"] : meta["byteOffset"] + meta["byteLength"]]
    return list(struct.unpack("<{}{}".format(meta["length"], fmt), raw))


# --------------------------------------------------------------------------- #
# an explicit x axis
# --------------------------------------------------------------------------- #


def test_a_second_expression_becomes_the_x_axis(np):
    """What makes a real scatter plot possible: y against another value."""
    document, payload = capture(np.array([10.0, 20.0, 30.0]), x=np.array([5.0, 6.0, 7.0]))

    assert read(document, payload, "x") == [5.0, 6.0, 7.0]
    assert read(document, payload, "y") == [10.0, 20.0, 30.0]


def test_a_mismatched_x_is_reported_and_ignored(np):
    """Pairing the wrong x with the wrong y is wrong in a way nobody can see.

    Truncating or padding to fit would produce a plot that looks entirely
    normal and means nothing, so the axis is refused instead.
    """
    document, _ = capture(np.arange(5.0), x=np.arange(3.0))

    assert "x" not in channels(document)
    warnings = " ".join(document["warnings"])
    assert "3" in warnings and "5" in warnings


def test_a_non_numeric_x_is_reported_and_ignored(np):
    document, _ = capture(np.arange(3.0), x=["a", "b", "c"])
    assert "x" not in channels(document)
    assert "not a flat sequence" in " ".join(document["warnings"])


def test_a_pandas_series_works_as_an_axis(np):
    pd = pytest.importorskip("pandas")
    document, payload = capture(np.array([1.0, 2.0]), x=pd.Series([9.0, 8.0]))
    assert read(document, payload, "x") == [9.0, 8.0]


def test_a_list_works_as_an_axis(np):
    document, payload = capture(np.array([1.0, 2.0]), x=[3, 4])
    assert read(document, payload, "x") == [3.0, 4.0]


# --------------------------------------------------------------------------- #
# the zoom window
# --------------------------------------------------------------------------- #


def test_a_window_crops_by_position(np):
    document, payload = capture(np.arange(100.0), range=[10, 19])

    assert read(document, payload, "y") == [float(v) for v in range(10, 20)]
    assert read(document, payload, "x") == [float(v) for v in range(10, 20)]


def test_a_window_is_applied_before_decimation(np):
    """The property that makes zooming worth anything.

    Decimating first and cropping afterwards leaves the zoomed view holding
    whatever few points survived the reduction of the *whole* series: narrower,
    but no more detailed. Cropping first re-spends the entire point budget
    inside the visible range.
    """
    values = np.sin(np.linspace(0, 200, 1_000_000))

    whole, _ = capture(values, maxPoints=1000)
    zoomed, payload = capture(values, maxPoints=1000, range=[500_000, 501_000])

    # Decimation reports what it reduced *from*. Cropping first makes that the
    # window; cropping afterwards would make it the whole million, and the view
    # would hold one point per thousand samples instead of nearly all of them.
    assert whole["descriptor"]["decimation"]["originalLength"] == 1_000_000
    assert zoomed["descriptor"]["decimation"]["originalLength"] == 1001

    # Roughly one transferred point per original sample inside the window.
    assert channels(zoomed)["y"]["length"] > 900
    assert all(500_000 <= position <= 501_000 for position in read(zoomed, payload, "x"))


def test_statistics_still_describe_the_whole_value_when_windowed(np):
    """The invariant zooming must not break.

    The stats strip is trustworthy precisely because its numbers do not move
    with the view. A spike outside the window still has to be reported.
    """
    values = np.zeros(1000)
    values[900] = 999.0

    document, _ = capture(values, range=[0, 100])

    assert document["descriptor"]["stats"]["count"] == 1000
    assert document["descriptor"]["stats"]["max"] == 999.0


def test_the_window_carries_its_own_statistics(np):
    values = np.zeros(1000)
    values[900] = 999.0
    values[50] = 5.0

    document, _ = capture(values, range=[0, 100])
    window = document["descriptor"]["window"]

    assert window["from"] == 0 and window["to"] == 100
    # Separate numbers, describing only what is on screen.
    assert window["stats"]["max"] == 5.0
    assert window["stats"]["count"] == 101


def test_a_window_on_an_explicit_axis_selects_by_value(np):
    document, payload = capture(
        np.array([1.0, 2.0, 3.0, 4.0]), x=np.array([10.0, 20.0, 30.0, 40.0]), range=[19, 31]
    )

    assert read(document, payload, "x") == [20.0, 30.0]
    assert read(document, payload, "y") == [2.0, 3.0]


def test_an_empty_window_does_not_crash(np):
    document, _ = capture(np.arange(10.0), range=[100, 200])
    assert document["ok"] is True
    assert channels(document)["y"]["length"] == 0


def test_a_malformed_range_is_ignored(np):
    for bad in ([1], [5, 5], ["a", "b"], "nope"):
        document, _ = capture(np.arange(10.0), range=bad)
        assert document["descriptor"]["window"] is None, bad
        assert channels(document)["y"]["length"] == 10


def test_no_window_means_no_window_field(np):
    document, _ = capture(np.arange(10.0))
    assert document["descriptor"]["window"] is None
