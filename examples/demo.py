"""Sample program for trying the extension out.

Set a breakpoint inside the loop in `smooth_with_outliers`, start the "Debug the
demo script" launch configuration, then open the visualizer and add a few
expressions:

    signal              a clean sine wave
    noisy               the same signal with noise and a few NaN gaps
    smoothed            the current state of the smoothing loop
    noisy - smoothed    what the filter removed so far
    field               a 2-D array -- try the Heatmap and Table views

Stepping through the loop is the interesting part: `smoothed` changes on every
iteration, which is exactly the case this tool is built for.

The second breakpoint, at the end of `main`, has the pandas side:

    prices                       a DataFrame on a DatetimeIndex
    prices[["close", "sma20"]]   two columns overlaid on a time axis
    prices["volume"]             switch this one to Histogram
    prices.index                 the index on its own

`prices` also carries a non-numeric column, which the tool reports rather than
quietly dropping.
"""

from __future__ import annotations

import warnings

import numpy as np


def make_signals(length: int = 5_000) -> tuple[np.ndarray, np.ndarray]:
    t = np.linspace(0, 40, length)
    signal = np.sin(t) + 0.3 * np.sin(3.7 * t)

    rng = np.random.default_rng(seed=20260801)
    noisy = signal + rng.normal(0, 0.15, size=length)

    # A dropout, so you can see that gaps stay gaps rather than being
    # interpolated away by downsampling.
    noisy[2_000:2_040] = np.nan

    # A couple of spikes, to check that the statistics report extremes the plot
    # may be too coarse to show.
    noisy[1_234] = 12.0
    noisy[3_999] = -9.5

    return signal, noisy


def smooth_with_outliers(noisy: np.ndarray, window: int = 25) -> np.ndarray:
    """A deliberately step-by-step moving average, so there is something to watch."""
    smoothed = np.full_like(noisy, np.nan)
    for start in range(0, len(noisy) - window, window):
        chunk = noisy[start : start + window]
        with warnings.catch_warnings():
            # Chunks lying entirely inside the dropout average to NaN. That is
            # the interesting case, not an accident: the gap propagates into
            # `smoothed`, so the plot shows a hole rather than a made-up value.
            warnings.simplefilter("ignore", RuntimeWarning)
            smoothed[start : start + window] = np.nanmean(chunk)  # <-- breakpoint here
    return smoothed


def make_prices(days: int = 400):
    """A DataFrame on a DatetimeIndex, for the time-series case.

    Returns None when pandas is not installed, so the rest of the demo still
    runs — the extension does not require it either.
    """
    try:
        import pandas as pd
    except ImportError:
        return None

    rng = np.random.default_rng(seed=7)
    index = pd.date_range("2025-01-01", periods=days, freq="B", name="date")
    close = 100 * np.exp(np.cumsum(rng.normal(0.0004, 0.012, days)))

    return pd.DataFrame(
        {
            "close": close,
            "sma20": pd.Series(close, index=index).rolling(20).mean().to_numpy(),
            "volume": rng.integers(1_000, 50_000, days).astype(float),
            "ticker": ["ACME"] * days,  # non-numeric on purpose: it must be reported, not dropped
        },
        index=index,
    )


def main() -> None:
    signal, noisy = make_signals()
    smoothed = smooth_with_outliers(noisy)

    field = np.outer(np.sin(np.linspace(0, 6, 200)), np.cos(np.linspace(0, 6, 300)))

    integers = np.arange(1_000, dtype=np.int64) ** 2
    booleans = np.abs(noisy) > 1.0
    plain_list = [float(v) for v in signal[:500]]

    prices = make_prices()  # DataFrame with a DatetimeIndex, or None without pandas

    print("signal", signal.shape, "smoothed", smoothed.shape)
    print("field", field.shape, "integers", integers.shape)
    print("booleans", booleans.sum(), "plain_list", len(plain_list))
    print("prices", None if prices is None else prices.shape)  # <-- second breakpoint here


if __name__ == "__main__":
    main()
