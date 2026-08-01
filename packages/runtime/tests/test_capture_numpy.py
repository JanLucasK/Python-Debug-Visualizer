from __future__ import annotations

import math
import struct

import pytest

from _pdv import extract as capture_module
from _pdv import envelope


def decode_capture(value, **options):
    import base64
    import json

    options_b64 = (
        base64.b64encode(json.dumps(options).encode("utf-8")).decode("ascii") if options else ""
    )
    return envelope.decode(capture_module.capture(value, options_b64))


def channel(document, name):
    for entry in document["descriptor"]["channels"]:
        if entry["name"] == name:
            return entry
    raise AssertionError("no channel {!r} in {}".format(name, document["descriptor"]["channels"]))


def read_channel(document, payload, name):
    meta = channel(document, name)
    fmt = {"f32": "f", "f64": "d", "i64": "q", "i32": "i", "u8": "B", "bool": "B"}[meta["dtype"]]
    raw = payload[meta["byteOffset"] : meta["byteOffset"] + meta["byteLength"]]
    return list(struct.unpack("<{}{}".format(meta["length"], fmt), raw))


def test_1d_float_array_roundtrip(np):
    values = np.array([1.5, 2.5, 3.5, 4.5], dtype=np.float64)
    document, payload = decode_capture(values)

    assert document["ok"] is True
    assert document["descriptor"]["kind"] == "ndarray"
    assert document["descriptor"]["dtype"] == "float64"
    assert document["descriptor"]["shape"] == [4]
    assert document["descriptor"]["suggestedViz"][0] == "line"
    assert read_channel(document, payload, "y") == [1.5, 2.5, 3.5, 4.5]


def test_float32_stays_f32_and_float16_widens(np):
    document, _ = decode_capture(np.arange(4, dtype=np.float32))
    assert channel(document, "y")["dtype"] == "f32"

    # float16 has no JavaScript counterpart, so it widens rather than failing.
    document, _ = decode_capture(np.arange(4, dtype=np.float16))
    assert channel(document, "y")["dtype"] == "f32"
    assert document["descriptor"]["dtype"] == "float16"


def test_stats_count_nan_and_inf_without_dropping_them(np):
    values = np.array([1.0, np.nan, 3.0, np.inf, -np.inf, 5.0])
    document, payload = decode_capture(values)

    stats = document["descriptor"]["stats"]
    assert stats["count"] == 6
    assert stats["nanCount"] == 1
    assert stats["infCount"] == 2
    # Extremes are over finite values only, so Inf must not become the maximum.
    assert stats["min"] == 1.0
    assert stats["max"] == 5.0

    # The values themselves keep their bit patterns; only the JSON is sanitised.
    transferred = read_channel(document, payload, "y")
    assert math.isnan(transferred[1])
    assert math.isinf(transferred[3])


def test_stats_describe_the_full_array_not_the_decimated_one(np):
    """The contract that makes the stats strip trustworthy.

    A plot may show 2000 of 200000 points, but the min/max shown beside it must
    still be the real ones -- including a spike that decimation dropped.
    """
    values = np.zeros(200_000, dtype=np.float64)
    values[123_456] = 999.0

    document, payload = decode_capture(values, maxPoints=2000)

    assert document["descriptor"]["decimation"]["originalLength"] == 200_000
    assert document["descriptor"]["decimation"]["outputLength"] <= 2000
    assert document["descriptor"]["stats"]["count"] == 200_000
    assert document["descriptor"]["stats"]["max"] == 999.0

    # Decimated data carries explicit x positions, since they are no longer 0..n-1.
    x = read_channel(document, payload, "x")
    assert len(x) == channel(document, "y")["length"]
    assert x == sorted(x)


def test_decimation_switches_to_minmax_when_gaps_are_present(np):
    """NaN gaps must survive decimation, or a broken series looks continuous."""
    values = np.arange(100_000, dtype=np.float64)
    values[40_000:40_500] = np.nan

    document, payload = decode_capture(values, maxPoints=2000)

    assert document["descriptor"]["decimation"]["method"] == "minmax"
    transferred = read_channel(document, payload, "y")
    assert any(math.isnan(v) for v in transferred), "the NaN gap was decimated away"


def test_clean_data_uses_lttb(np):
    values = np.sin(np.linspace(0, 20, 100_000))
    document, _ = decode_capture(values, maxPoints=2000)
    assert document["descriptor"]["decimation"]["method"] == "lttb"


def test_small_array_is_not_decimated(np):
    document, payload = decode_capture(np.arange(10, dtype=np.float64))
    assert document["descriptor"]["decimation"] is None
    # No decimation means positions are implicit, so no x channel is sent.
    assert [c["name"] for c in document["descriptor"]["channels"]] == ["y"]


def test_integer_and_bool_arrays(np):
    document, payload = decode_capture(np.array([1, 2, 3], dtype=np.int32))
    assert channel(document, "y")["dtype"] == "i32"
    assert read_channel(document, payload, "y") == [1, 2, 3]

    document, payload = decode_capture(np.array([True, False, True]))
    assert channel(document, "y")["dtype"] == "bool"
    assert read_channel(document, payload, "y") == [1, 0, 1]


def test_2d_array_suggests_heatmap(np):
    document, payload = decode_capture(np.arange(12, dtype=np.float64).reshape(3, 4))
    assert document["descriptor"]["shape"] == [3, 4]
    assert document["descriptor"]["suggestedViz"][0] == "heatmap"
    assert channel(document, "value")["length"] == 12


def test_large_2d_array_is_strided_and_says_so(np):
    document, _ = decode_capture(np.zeros((4000, 4000), dtype=np.float32), maxCells=1_000_000)
    assert document["descriptor"]["truncated"] is True
    assert document["warnings"], "striding must be reported, not silent"
    rows, cols = document["descriptor"]["shape"]
    assert rows * cols <= 1_000_000


def test_unsupported_dtype_still_reports_shape_and_type(np):
    """Being unable to plot something is not a reason to say nothing about it."""
    document, _ = decode_capture(np.array([1 + 2j, 3 + 4j]))

    assert document["ok"] is True
    assert document["descriptor"]["shape"] == [2]
    assert document["descriptor"]["dtype"] == "complex128"
    assert document["descriptor"]["channels"] == []
    assert "np.abs" in " ".join(document["warnings"])


def test_high_dimensional_array_explains_how_to_proceed(np):
    document, _ = decode_capture(np.zeros((2, 3, 4, 5)))
    assert document["descriptor"]["shape"] == [2, 3, 4, 5]
    assert "Slice" in " ".join(document["warnings"])


def test_empty_array(np):
    document, payload = decode_capture(np.array([], dtype=np.float64))
    assert document["descriptor"]["stats"]["count"] == 0
    assert document["descriptor"]["stats"]["min"] is None
    assert payload == b""


def test_numpy_scalar(np):
    document, _ = decode_capture(np.float64(3.25))
    assert document["descriptor"]["kind"] == "scalar"
    assert document["descriptor"]["stats"]["mean"] == 3.25


def test_big_endian_array_is_converted(np):
    values = np.array([1.0, 2.0, 3.0], dtype=">f8")
    document, payload = decode_capture(values)
    assert read_channel(document, payload, "y") == [1.0, 2.0, 3.0]


def test_rgb_array_becomes_an_image(np):
    picture = np.zeros((4, 6, 3), dtype=np.uint8)
    picture[0, 0] = [255, 128, 64]

    document, payload = decode_capture(picture)

    assert document["descriptor"]["suggestedViz"][0] == "image"
    assert document["descriptor"]["shape"] == [4, 6, 3]
    assert channel(document, "pixel")["dtype"] == "u8"
    assert list(payload[:3]) == [255, 128, 64]


def test_rgba_array_keeps_its_alpha(np):
    picture = np.zeros((2, 2, 4), dtype=np.uint8)
    picture[0, 0] = [1, 2, 3, 200]

    document, payload = decode_capture(picture)
    assert document["descriptor"]["shape"] == [2, 2, 4]
    assert payload[3] == 200


def test_float_image_uses_the_zero_to_one_convention(np):
    """Every imaging library in Python reads floats as 0-1.

    Rescaling from the observed range instead would make a deliberately dark
    image look correctly exposed, hiding exactly the bug someone opened the
    debugger to find.
    """
    picture = np.zeros((2, 2, 3), dtype=np.float64)
    picture[0, 0] = [0.0, 0.5, 1.0]

    document, payload = decode_capture(picture)
    assert list(payload[:3]) == [0, 127, 255]
    assert document["warnings"] == []


def test_out_of_range_float_image_is_clipped_and_reported(np):
    picture = np.full((2, 2, 3), 4.0)
    document, payload = decode_capture(picture)

    assert all(byte == 255 for byte in payload[:12])
    assert "clipped" in " ".join(document["warnings"])


def test_large_image_is_strided_and_says_so(np):
    document, _ = decode_capture(np.zeros((4000, 4000, 3), dtype=np.uint8), maxPixels=250_000)
    rows, cols, depth = document["descriptor"]["shape"]

    assert rows * cols <= 250_000
    assert depth == 3
    assert document["descriptor"]["truncated"] is True
    assert document["warnings"]


def test_3d_array_that_is_not_an_image_still_explains_itself(np):
    document, _ = decode_capture(np.zeros((5, 5, 7)))
    assert document["descriptor"]["channels"] == []
    assert "Slice" in " ".join(document["warnings"])
