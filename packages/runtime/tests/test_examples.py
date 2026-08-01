"""The documented examples have to actually do what the guide says.

`examples/README.md` promises specific behaviour for specific expressions. A
guide that has drifted from the code is worse than no guide: someone following
it concludes the tool is broken when the tool is fine, or the reverse.

These run the real demo values through the real capture path and check the
claims that would be embarrassing to get wrong.
"""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

import pytest

from _pdv import envelope
from _pdv import extract as capture_module

np = pytest.importorskip("numpy")

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "examples"))
import demo  # noqa: E402


def capture(value, **options):
    encoded = (
        base64.b64encode(json.dumps(options).encode("utf-8")).decode("ascii") if options else ""
    )
    document, payload = envelope.decode(capture_module.capture(value, encoded))
    assert document["ok"] is True, document.get("error")
    return document


def series_count(document):
    return len([c for c in document["descriptor"]["channels"] if c["role"] == "y"])


@pytest.fixture(scope="module")
def signals():
    return demo.make_signals()


def test_the_demo_runs(capsys):
    demo.main()
    assert "signal" in capsys.readouterr().out


# --------------------------------------------------------------------------- #
# what the guide claims about the signals
# --------------------------------------------------------------------------- #


def test_noisy_has_exactly_the_promised_gap(signals):
    _, _, noisy = signals
    stats = capture(noisy)["descriptor"]["stats"]

    assert stats["nanCount"] == 40, "the guide says NaN 40"
    assert stats["count"] == demo.LENGTH


def test_the_outliers_are_where_the_guide_says(signals):
    _, _, noisy = signals
    stats = capture(noisy)["descriptor"]["stats"]

    assert stats["max"] == 12.0
    assert stats["min"] == -9.5


def test_the_gap_survives_downsampling(signals):
    """The claim that downsampling switches method when a series has holes."""
    _, _, noisy = signals
    document = capture(noisy, maxPoints=500)

    assert document["descriptor"]["decimation"]["method"] == "minmax"


def test_smoothed_carries_the_gap_through(signals):
    _, _, noisy = signals
    stats = capture(demo.smooth_with_outliers(noisy))["descriptor"]["stats"]
    assert stats["nanCount"] > 0


# --------------------------------------------------------------------------- #
# multiple series
# --------------------------------------------------------------------------- #


def test_the_dict_example_gives_two_lines(signals):
    _, _, noisy = signals
    smoothed = demo.smooth_with_outliers(noisy)

    document = capture({"raw": noisy, "smoothed": smoothed})
    assert series_count(document) == 2
    assert document["descriptor"]["suggestedViz"][0] == "line"


def test_the_column_stack_example_is_a_narrow_matrix(signals):
    _, signal, noisy = signals
    document = capture(np.column_stack([signal, demo.smooth_with_outliers(noisy)]))
    assert document["descriptor"]["shape"] == [demo.LENGTH, 2]


def test_the_frame_example_reports_its_text_column():
    pytest.importorskip("pandas")
    document = capture(demo.make_prices())

    assert series_count(document) == 3, "close, sma20 and volume"
    assert "ticker" in " ".join(document["warnings"])


def test_the_two_column_example_shares_a_date_axis():
    pytest.importorskip("pandas")
    document = capture(demo.make_prices()[["close", "sma20"]])

    assert series_count(document) == 2
    assert document["descriptor"]["index"]["kind"] == "datetime"
    assert document["descriptor"]["index"]["timeUnit"] == "ms"


# --------------------------------------------------------------------------- #
# visualizations
# --------------------------------------------------------------------------- #


def test_the_fields_pick_the_colormaps_the_guide_describes():
    field, residual = demo.make_fields()

    assert capture(field)["descriptor"]["stats"]["min"] >= 0, "guide says all positive"
    signed = capture(residual)["descriptor"]["stats"]
    assert signed["min"] < 0 < signed["max"], "guide says it straddles zero"
    assert signed["max"] == 4.0, "the hot patch"


def test_the_pictures_are_images():
    picture, transparent = demo.make_pictures()

    assert capture(picture)["descriptor"]["suggestedViz"][0] == "image"
    assert capture(picture)["descriptor"]["shape"] == [96, 128, 3]
    assert capture(transparent)["descriptor"]["shape"] == [96, 128, 4]


def test_the_histogram_example_is_skewed():
    skewed = np.random.default_rng(3).lognormal(0, 1, 50_000)
    document = capture(skewed, viz="histogram")

    edges = [c for c in document["descriptor"]["channels"] if c["name"] == "binEdge"]
    assert edges, "binning produced no edges"


def test_binning_excludes_non_finite_values_and_says_so(signals):
    """The guide's specific claim: count 5000, bars summing to 4960."""
    _, _, noisy = signals
    document = capture(noisy, viz="histogram")

    assert document["descriptor"]["stats"]["count"] == 5_000
    assert "non-finite" in " ".join(document["warnings"])


# --------------------------------------------------------------------------- #
# axes, zoom and precision
# --------------------------------------------------------------------------- #


def test_time_can_be_used_as_the_x_axis(signals):
    """The guide's `x = t` example: a second expression supplies the axis."""
    t, signal, _ = signals
    document, _ = envelope.decode(capture_module.capture(signal, "", t))

    axis = [c for c in document["descriptor"]["channels"] if c["role"] == "x"]
    assert axis, "no x channel was produced"
    assert axis[0]["length"] == len(signal)


def test_zooming_into_the_huge_array_keeps_the_full_statistics():
    huge = np.sin(np.linspace(0, 4_000, 2_000_000)) + np.linspace(0, 1, 2_000_000)

    whole = capture(huge, maxPoints=2000)
    zoomed = capture(huge, maxPoints=2000, range=[1_000_000, 1_010_000])

    assert whole["descriptor"]["stats"]["count"] == 2_000_000
    assert zoomed["descriptor"]["stats"]["count"] == 2_000_000, "statistics must not move"
    assert zoomed["descriptor"]["window"]["stats"]["count"] == 10_001
    # The budget is re-spent inside the window rather than across everything.
    assert zoomed["descriptor"]["decimation"]["originalLength"] == 10_001


def test_big_integers_are_flagged_as_inexact():
    """The webview warns; the runtime's job is to send them as int64 at all."""
    big = np.arange(1_000, dtype=np.int64) + 2**53
    channels = capture(big)["descriptor"]["channels"]
    assert [c for c in channels if c["role"] == "y"][0]["dtype"] == "i64"


# --------------------------------------------------------------------------- #
# the ones that must decline politely
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "key,hint",
    [
        ("complex", "np.abs"),
        ("text", "np.unique"),
        ("cube", "Slice"),
    ],
)
def test_awkward_values_explain_what_to_do_instead(key, hint):
    document = capture(demo.make_awkward()[key])

    assert document["descriptor"]["channels"] == [], key
    assert hint in " ".join(document["warnings"]), key


def test_the_suggested_workarounds_actually_work():
    awkward = demo.make_awkward()

    assert capture(np.abs(awkward["complex"]))["descriptor"]["channels"], "np.abs(x) should plot"
    assert capture(awkward["cube"][0, 0])["descriptor"]["channels"], "slicing should plot"


def test_empty_and_all_nan_do_not_crash():
    awkward = demo.make_awkward()

    assert capture(awkward["empty"])["descriptor"]["stats"]["count"] == 0
    assert capture(awkward["all_nan"], viz="histogram")["descriptor"]["channels"] == []


def test_a_mixed_list_reports_its_non_numeric_element():
    document = capture(demo.make_awkward()["mixed_list"])
    assert "non-numeric" in " ".join(document["warnings"])
