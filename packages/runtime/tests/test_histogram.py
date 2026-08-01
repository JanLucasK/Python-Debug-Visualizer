from __future__ import annotations

import base64
import json
import math
import struct

import pytest

from _pdv import envelope
from _pdv import extract as capture_module


def histogram(value, **options):
    options.setdefault("viz", "histogram")
    encoded = base64.b64encode(json.dumps(options).encode("utf-8")).decode("ascii")
    document, payload = envelope.decode(capture_module.capture(value, encoded))

    channels = {c["name"]: c for c in document["descriptor"]["channels"]}
    if not channels:
        return document, [], []

    def read(name, fmt):
        meta = channels[name]
        raw = payload[meta["byteOffset"] : meta["byteOffset"] + meta["byteLength"]]
        return list(struct.unpack("<{}{}".format(meta["length"], fmt), raw))

    return document, read("binEdge", "d"), read("binCount", "q")


def test_numpy_histogram_counts_every_finite_value(np):
    values = np.concatenate([np.zeros(100), np.ones(200), np.full(300, 2.0)])
    document, edges, counts = histogram(values, bins=3)

    assert len(edges) == len(counts) + 1
    assert sum(counts) == 600
    assert document["descriptor"]["suggestedViz"] == ["histogram"]


def test_bins_are_transferred_not_the_points(np):
    """The reason binning happens in Python at all."""
    document, edges, counts = histogram(np.random.default_rng(0).normal(size=5_000_000), bins=64)

    assert len(counts) == 64
    assert sum(counts) == 5_000_000
    # 5 million points would be 40 MB; 64 bins plus edges is under a kilobyte.
    assert document["descriptor"]["stats"]["count"] == 5_000_000


def test_non_finite_values_are_excluded_but_reported(np):
    values = np.array([1.0, 2.0, 3.0, np.nan, np.inf])
    document, _, counts = histogram(values, bins=2)

    # Bars must sum to the finite values only -- but silently dropping two
    # elements is exactly the kind of quiet lie this project refuses.
    assert sum(counts) == 3
    assert document["descriptor"]["stats"]["count"] == 5
    assert "non-finite" in " ".join(document["warnings"])


def test_automatic_bin_count_adapts_to_the_data(np):
    rng = np.random.default_rng(1)
    _, narrow_edges, _ = histogram(rng.normal(scale=0.01, size=10_000))
    _, wide_edges, _ = histogram(rng.normal(scale=100.0, size=10_000))

    # Freedman-Diaconis scales bin width with spread, so both get a sane count
    # rather than one bar or five hundred.
    for edges in (narrow_edges, wide_edges):
        assert 4 <= len(edges) - 1 <= 512


def test_constant_array_still_produces_one_bar(np):
    """Zero interquartile range must not become a division by zero."""
    _, edges, counts = histogram(np.full(1000, 7.0))
    assert sum(counts) == 1000
    assert len(edges) >= 2


def test_all_nan_array_reports_instead_of_charting(np):
    document, edges, counts = histogram(np.full(100, np.nan))
    assert edges == [] and counts == []
    assert "No finite values" in " ".join(document["warnings"])


def test_bin_count_is_capped(np):
    _, edges, _ = histogram(np.arange(100_000, dtype=np.float64), bins=100_000)
    assert len(edges) - 1 <= 512


def test_2d_array_is_flattened_for_binning(np):
    _, _, counts = histogram(np.arange(60, dtype=np.float64).reshape(6, 10), bins=6)
    assert sum(counts) == 60


def test_plain_list_histogram_uses_the_same_wire_shape():
    document, edges, counts = histogram([1.0, 1.0, 2.0, 5.0], bins=4)

    assert len(edges) == len(counts) + 1
    assert sum(counts) == 4
    assert document["descriptor"]["kind"] == "sequence"


def test_plain_list_puts_the_maximum_in_the_last_bin():
    """Off-by-one at the top edge silently loses the largest element."""
    _, _, counts = histogram([0.0, 1.0, 2.0, 3.0, 4.0], bins=2)
    assert sum(counts) == 5


def test_plain_list_with_constant_values():
    _, edges, counts = histogram([3.0] * 10)
    assert counts == [10]
    assert len(edges) == 2
