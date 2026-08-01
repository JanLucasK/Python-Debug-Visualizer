from __future__ import annotations

import base64
import json
import struct

import pytest

from _pdv import envelope
from _pdv import extract as capture_module

pd = pytest.importorskip("pandas")


@pytest.fixture
def np():
    return pytest.importorskip("numpy")


def capture(value, **options):
    encoded = (
        base64.b64encode(json.dumps(options).encode("utf-8")).decode("ascii") if options else ""
    )
    return envelope.decode(capture_module.capture(value, encoded))


def channels(document):
    return {c["name"]: c for c in document["descriptor"]["channels"]}


def read(document, payload, name):
    meta = channels(document)[name]
    fmt = {"f32": "f", "f64": "d", "i64": "q", "i32": "i", "u8": "B", "bool": "B"}[meta["dtype"]]
    raw = payload[meta["byteOffset"] : meta["byteOffset"] + meta["byteLength"]]
    return list(struct.unpack("<{}{}".format(meta["length"], fmt), raw))


def test_series_becomes_a_named_line():
    series = pd.Series([1.0, 2.0, 3.0], name="close")
    document, payload = capture(series)

    assert document["descriptor"]["kind"] == "series"
    assert read(document, payload, "close") == [1.0, 2.0, 3.0]
    assert document["descriptor"]["suggestedViz"][0] == "line"


def test_unnamed_series_still_gets_a_label():
    document, _ = capture(pd.Series([1.0, 2.0]))
    assert "value" in channels(document)


@pytest.mark.parametrize("unit", ["s", "ms", "us", "ns"])
def test_datetime_index_travels_as_milliseconds_whatever_its_resolution(unit):
    """The resolution of the source array must not leak into the wire values.

    `asi8` returns raw integers in the array's own unit, and that unit is not
    stable: pandas 3.0 gives `date_range` seconds where 1.x always gave
    nanoseconds. Assuming one of them puts every timestamp off by a factor of a
    thousand — and the resulting plot still looks completely plausible.
    """
    index = pd.date_range("2026-01-01", periods=3, freq="D").as_unit(unit)
    document, payload = capture(pd.Series([1.0, 2.0, 3.0], index=index, name="v"))

    info = document["descriptor"]["index"]
    assert info["kind"] == "datetime"
    assert info["timeUnit"] == "ms"

    stamps = read(document, payload, "x")
    # 2026-01-01T00:00:00Z, in milliseconds since the epoch.
    assert stamps[0] == 1_767_225_600_000
    assert stamps[1] - stamps[0] == 86_400_000  # one day


def test_datetime_index_stays_within_exact_integer_range():
    """Milliseconds rather than nanoseconds, so JavaScript can hold them exactly."""
    document, payload = capture(
        pd.Series([1.0], index=pd.DatetimeIndex(["2262-04-11"]), name="v")
    )
    assert abs(read(document, payload, "x")[0]) < 2**53


def test_string_index_falls_back_to_positions_rather_than_faking_a_number_line():
    series = pd.Series([3.0, 1.0, 2.0], index=["c", "a", "b"], name="v")
    document, _ = capture(series)

    assert document["descriptor"]["index"]["kind"] == "other"
    # No x channel: ordering strings as numbers would reorder the data.
    assert "x" not in channels(document)


def test_frame_becomes_one_channel_per_numeric_column():
    frame = pd.DataFrame({"a": [1.0, 2.0], "b": [3.0, 4.0]})
    document, payload = capture(frame)

    assert document["descriptor"]["kind"] == "frame"
    assert read(document, payload, "a") == [1.0, 2.0]
    assert read(document, payload, "b") == [3.0, 4.0]
    assert document["descriptor"]["shape"] == [2, 2]


def test_frame_reports_non_numeric_columns_instead_of_dropping_them_silently():
    frame = pd.DataFrame({"a": [1.0, 2.0], "label": ["x", "y"]})
    document, _ = capture(frame)

    assert "label" not in channels(document)
    assert "non-numeric" in " ".join(document["warnings"])

    described = {c["name"]: c for c in document["descriptor"]["columns"]}
    assert described["label"]["numeric"] is False
    assert described["a"]["numeric"] is True


def test_frame_columns_share_one_decimation(np):
    """Columns decimated independently would land on different x positions.

    Plotting them together is the whole point, and comparing series sampled at
    different places is worse than not plotting them at all.
    """
    frame = pd.DataFrame(
        {"a": np.sin(np.linspace(0, 20, 50_000)), "b": np.cos(np.linspace(0, 20, 50_000))}
    )
    document, _ = capture(frame, maxPoints=1000)

    lengths = {name: meta["length"] for name, meta in channels(document).items()}
    assert lengths["a"] == lengths["b"] == lengths["x"]
    assert document["descriptor"]["decimation"]["originalLength"] == 50_000


def test_per_column_statistics_are_reported():
    frame = pd.DataFrame({"small": [1.0, 2.0], "large": [1000.0, 2000.0]})
    document, _ = capture(frame)

    described = {c["name"]: c for c in document["descriptor"]["columns"]}
    assert described["small"]["stats"]["max"] == 2.0
    assert described["large"]["stats"]["max"] == 2000.0


def test_empty_frame_explains_itself():
    document, _ = capture(pd.DataFrame({"label": ["a", "b"]}))
    assert document["descriptor"]["channels"] == []
    assert "No numeric columns" in " ".join(document["warnings"])


def test_frame_histogram_names_the_column_it_binned():
    frame = pd.DataFrame({"a": [1.0, 2.0, 3.0, 4.0], "b": [10.0, 20.0, 30.0, 40.0]})
    document, _ = capture(frame, viz="histogram", bins=2)

    # Binning every column together would merge unrelated units into one
    # distribution, so it bins one and says which.
    assert "binCount" in channels(document)
    assert "'a'" in " ".join(document["warnings"])


def test_series_histogram_keeps_the_pandas_type():
    document, _ = capture(pd.Series([1.0, 2.0, 3.0], name="v"), viz="histogram", bins=2)
    assert "Series" in document["descriptor"]["pythonType"]
    assert "binEdge" in channels(document)


def test_datetime_index_on_its_own():
    document, payload = capture(pd.date_range("2026-01-01", periods=4, freq="h"))
    assert document["descriptor"]["kind"] == "index"
    assert len(read(document, payload, "value")) == 4


def test_nan_handling_matches_the_numpy_path(np):
    series = pd.Series([1.0, np.nan, 3.0], name="v")
    document, _ = capture(series)

    stats = document["descriptor"]["stats"]
    assert stats["count"] == 3
    assert stats["nanCount"] == 1
    assert stats["max"] == 3.0


def test_boolean_column_is_plottable():
    document, payload = capture(pd.Series([True, False, True], name="mask"))
    assert read(document, payload, "mask") == [1, 0, 1]


def test_pandas_wins_over_numpy_for_a_series():
    """Otherwise the NumPy adapter claims it through the array interface and the
    column name and index are lost."""
    from _pdv.registry import registry

    adapter = registry.resolve(pd.Series([1.0], name="v"))
    assert adapter is not None and adapter.name == "pandas"
