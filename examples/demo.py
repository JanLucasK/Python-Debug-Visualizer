"""Sample program for trying the extension out.

Set a breakpoint inside the loop in `smooth_with_outliers`, start the "Debug the
demo script" launch configuration, then open the visualizer and add a few
expressions:

    signal              a clean sine wave
    noisy               the same signal with noise and a few NaN gaps
    smoothed            the current state of the smoothing loop
    noisy - smoothed    what the filter removed so far
    field               a 2-D array

Stepping through the loop is the interesting part: `smoothed` changes on every
iteration, which is exactly the case this tool is built for.
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


def main() -> None:
    signal, noisy = make_signals()
    smoothed = smooth_with_outliers(noisy)

    field = np.outer(np.sin(np.linspace(0, 6, 200)), np.cos(np.linspace(0, 6, 300)))

    integers = np.arange(1_000, dtype=np.int64) ** 2
    booleans = np.abs(noisy) > 1.0
    plain_list = [float(v) for v in signal[:500]]

    print("signal", signal.shape, "smoothed", smoothed.shape)
    print("field", field.shape, "integers", integers.shape)
    print("booleans", booleans.sum(), "plain_list", len(plain_list))


if __name__ == "__main__":
    main()
