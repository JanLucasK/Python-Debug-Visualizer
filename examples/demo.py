"""Sample program covering every feature of Python Debug Plots.

Run the "Debug the demo script" launch configuration. There are two breakpoints
worth using, marked below:

1. **Inside the smoothing loop** — for stepping, pinning and comparing. This is
   the case the whole tool is built around: watching one value change.
2. **At the end of `main`** — everything else is in scope there.

`examples/README.md` lists what to type and what each thing should show.

Nothing here needs pandas or torch; those sections degrade to `None` so the
demo still runs on a bare interpreter, exactly as the extension does.
"""

from __future__ import annotations

import warnings

import numpy as np

LENGTH = 5_000


# --------------------------------------------------------------------------- #
# 1-D signals: lines, gaps, outliers, distributions
# --------------------------------------------------------------------------- #


def make_signals(length: int = LENGTH):
    """A clean wave and a messy version of it."""
    t = np.linspace(0, 40, length)
    signal = np.sin(t) + 0.3 * np.sin(3.7 * t)

    rng = np.random.default_rng(seed=20260801)
    noisy = signal + rng.normal(0, 0.15, size=length)

    # A dropout, so gaps can be seen surviving downsampling instead of being
    # quietly closed.
    noisy[2_000:2_040] = np.nan

    # Two single-sample outliers, to check that the statistics report extremes
    # the plot is far too coarse to show.
    noisy[1_234] = 12.0
    noisy[3_999] = -9.5

    return t, signal, noisy


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
            smoothed[start : start + window] = np.nanmean(chunk)  # <-- BREAKPOINT 1
    return smoothed


# --------------------------------------------------------------------------- #
# matrices and pictures
# --------------------------------------------------------------------------- #


def make_fields():
    """A plain field and a signed one, which pick different colormaps."""
    rows = np.sin(np.linspace(0, 6, 200))[:, None]
    cols = np.cos(np.linspace(0, 6, 300))[None, :]

    field = np.abs(np.outer(rows.ravel(), cols.ravel()))  # all positive -> viridis
    residual = rows * cols  # straddles zero -> diverging, centred on zero
    residual[90:96, 140:146] = 4.0  # a hot patch, to check it stays a hard square

    return field, residual


def make_pictures():
    """H x W x 3 and H x W x 4, to exercise the image view and its alpha."""
    gradient = np.linspace(0, 1, 128)
    picture = np.stack(
        [
            np.tile(gradient, (96, 1)),
            np.tile(gradient[::-1], (96, 1)),
            np.tile(np.linspace(0, 1, 96)[:, None], (1, 128)),
        ],
        axis=-1,
    )

    alpha = np.linspace(0, 1, 128)[None, :].repeat(96, axis=0)
    transparent = np.dstack([picture, alpha])

    return picture, transparent


# --------------------------------------------------------------------------- #
# tabular data
# --------------------------------------------------------------------------- #


def make_prices(days: int = 400):
    """A DataFrame on a DatetimeIndex. Returns None when pandas is absent."""
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
            # Non-numeric on purpose: it must be reported, not silently dropped.
            "ticker": ["ACME"] * days,
        },
        index=index,
    )


def make_tensor():
    """A tensor still attached to the autograd graph. None when torch is absent."""
    try:
        import torch
    except ImportError:
        return None
    return torch.linspace(-3, 3, 400).requires_grad_(True)


# --------------------------------------------------------------------------- #
# values that cannot be plotted, and must say why
# --------------------------------------------------------------------------- #


def make_awkward():
    """Everything the tool has to decline gracefully rather than break on."""
    return {
        "complex": np.exp(1j * np.linspace(0, 10, 500)),
        "text": np.array(["alpha", "beta", "gamma"]),
        "cube": np.zeros((4, 5, 6, 7)),
        "objects": {"name": "acme", "config": {"depth": 3}},
        "mixed_list": [1.0, "two", 3.0],
        "empty": np.array([], dtype=np.float64),
        "all_nan": np.full(100, np.nan),
    }


def main() -> None:
    t, signal, noisy = make_signals()
    smoothed = smooth_with_outliers(noisy)
    residual_1d = noisy - smoothed

    field, residual = make_fields()
    picture, transparent = make_pictures()

    # Big enough to be downsampled and to leave via the binary side channel.
    huge = np.sin(np.linspace(0, 4_000, 2_000_000)) + np.linspace(0, 1, 2_000_000)

    # Exponential, so a log y axis turns it into a straight line.
    exponential = np.exp(np.linspace(0, 12, 2_000))

    # Skewed, so automatic binning has something to adapt to.
    skewed = np.random.default_rng(3).lognormal(0, 1, 50_000)

    integers = np.arange(1_000, dtype=np.int64) ** 2
    big_integers = np.arange(1_000, dtype=np.int64) + 2**53  # beyond exact in JS
    booleans = np.abs(noisy) > 1.0
    plain_list = [float(v) for v in signal[:500]]

    prices = make_prices()  # DataFrame or None
    tensor = make_tensor()  # torch.Tensor or None
    awkward = make_awkward()

    print("signal", signal.shape, "smoothed", smoothed.shape, "huge", huge.shape)
    print("field", field.shape, "picture", picture.shape, "transparent", transparent.shape)
    print("integers", integers.shape, "booleans", int(booleans.sum()))
    print("prices", None if prices is None else prices.shape)
    print("tensor", None if tensor is None else tuple(tensor.shape))
    print("awkward", sorted(awkward))  # <-- BREAKPOINT 2




if __name__ == "__main__":
    main()
