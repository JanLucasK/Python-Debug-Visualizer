from __future__ import annotations

import base64
import json
import struct

import pytest

from _pdv import envelope
from _pdv import extract as capture_module


def capture(value, **options):
    encoded = (
        base64.b64encode(json.dumps(options).encode("utf-8")).decode("ascii") if options else ""
    )
    return envelope.decode(capture_module.capture(value, encoded))


def channels(document):
    return {c["name"]: c for c in document["descriptor"]["channels"]}


def read(document, payload, name):
    meta = channels(document)[name]
    fmt = {"f64": "d", "i64": "q"}[meta["dtype"]]
    raw = payload[meta["byteOffset"] : meta["byteOffset"] + meta["byteLength"]]
    return list(struct.unpack("<{}{}".format(meta["length"], fmt), raw))


def test_dict_of_lists_becomes_several_named_series():
    """The point of the adapter: overlaying two arrays without needing pandas."""
    document, payload = capture({"raw": [1.0, 2.0, 3.0], "smoothed": [1.0, 1.5, 2.0]})

    assert document["descriptor"]["suggestedViz"][0] == "line"
    assert read(document, payload, "raw") == [1.0, 2.0, 3.0]
    assert read(document, payload, "smoothed") == [1.0, 1.5, 2.0]


def test_dict_of_numpy_arrays(np):
    document, payload = capture({"a": np.arange(4.0), "b": np.arange(4.0) * 2})

    assert read(document, payload, "a") == [0.0, 1.0, 2.0, 3.0]
    assert read(document, payload, "b") == [0.0, 2.0, 4.0, 6.0]


def test_non_numeric_entries_are_reported_not_dropped_silently():
    document, _ = capture({"a": [1.0, 2.0], "label": "hello", "meta": {"x": 1}})

    assert "a" in channels(document)
    assert "label" not in channels(document)
    warnings = " ".join(document["warnings"])
    assert "label" in warnings and "meta" in warnings


def test_entries_of_different_lengths_are_reported():
    """Stretching them onto a shared axis would put points where there are none."""
    document, _ = capture({"a": [1.0, 2.0, 3.0], "b": [1.0, 2.0, 3.0], "short": [1.0]})

    assert set(channels(document)) >= {"a", "b"}
    assert "short" not in channels(document)
    assert "different length" in " ".join(document["warnings"])


def test_all_entries_share_one_decimation(np):
    a = np.sin(np.linspace(0, 20, 50_000))
    b = np.cos(np.linspace(0, 20, 50_000))
    document, _ = capture({"a": a, "b": b}, maxPoints=1000)

    lengths = {name: meta["length"] for name, meta in channels(document).items()}
    assert lengths["a"] == lengths["b"] == lengths["x"]
    assert document["descriptor"]["decimation"]["originalLength"] == 50_000


def test_per_entry_statistics():
    document, _ = capture({"small": [1.0, 2.0], "large": [100.0, 200.0]})
    described = {c["name"]: c for c in document["descriptor"]["columns"]}

    assert described["small"]["stats"]["max"] == 2.0
    assert described["large"]["stats"]["max"] == 200.0


def test_dict_with_nothing_numeric_falls_back_to_a_description():
    document, _ = capture({"name": "acme", "config": {"a": 1}})

    assert document["descriptor"]["channels"] == []
    assert document["descriptor"]["suggestedViz"] == ["tree"]
    assert "No entry" in " ".join(document["warnings"])


def test_histogram_of_a_dict_names_the_entry_it_binned():
    document, _ = capture({"a": [1.0, 2.0, 3.0, 4.0]}, viz="histogram", bins=2)

    assert "binCount" in channels(document)
    assert "'a'" in " ".join(document["warnings"])


def test_too_many_entries_are_capped_and_reported():
    document, _ = capture({str(i): [1.0, 2.0] for i in range(50)})

    series = [name for name, meta in channels(document).items() if meta["role"] == "y"]
    assert len(series) == 32
    assert "first 32" in " ".join(document["warnings"])


def test_pandas_still_wins_for_a_dataframe():
    """A DataFrame is dict-like; the mapping adapter must not claim it."""
    pd = pytest.importorskip("pandas")
    from _pdv.registry import registry

    adapter = registry.resolve(pd.DataFrame({"a": [1.0]}))
    assert adapter is not None and adapter.name == "pandas"


def test_nan_handling_matches_the_other_adapters(np):
    document, _ = capture({"a": np.array([1.0, np.nan, 3.0])})
    stats = {c["name"]: c for c in document["descriptor"]["columns"]}["a"]["stats"]

    assert stats["nanCount"] == 1
    assert stats["max"] == 3.0
