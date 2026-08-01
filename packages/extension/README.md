# Python Debug Visualizer

Plot and inspect NumPy arrays, Pandas DataFrames and tensors **while you are
stopped in the debugger**. Type an expression, see the data.

## Getting started

1. Start a Python debug session and pause it.
2. Run **Python Debug Visualizer: Open Visualizer** from the Command Palette.
3. Type an expression — `prices[-500:]`, `df["close"].values`, `weights` — and
   press Enter.

You can also select an expression in the editor and press `Ctrl+Alt+V`
(`Cmd+Alt+V` on macOS), or right-click a variable in the Variables view and
choose **Visualize**.

Expressions are re-evaluated every time the debugger stops, so stepping through
a loop animates the plot. Freeze a pane to hold it still for comparison.

## What you get

- **Line, scatter, histogram, heatmap, image and table** views, chosen per pane
  or suggested automatically from the value.
- **A statistics strip** showing shape, dtype, min, max, mean, std and NaN/Inf
  counts — always computed over the *whole* value, even when the plot is
  downsampled.
- **Step back and compare.** Each pane keeps its recent captures. Scrub through
  them, pin one, and later steps are drawn against it as a dashed line with a
  count of how many points actually moved and by how much.
- **Honest downsampling.** Large arrays are reduced before transfer, and the
  pane says so. When a series contains NaN, downsampling switches to a method
  that keeps the gaps visible instead of quietly closing them.
- **Zoom that adds detail.** Drag-select a range and the runtime re-captures
  inside it, spending the whole point budget on what you are looking at. The
  statistics keep describing the complete value, with the window's own numbers
  beside them.
- **Any expression as the x axis**, so you can plot one quantity against another
  rather than against its index.

Works with NumPy arrays, Pandas DataFrames, Series and indexes, PyTorch and
TensorFlow tensors, and plain lists. Anything else is described — type, shape
and repr — rather than refused.

## No installation in your project

The Python side is injected into the debug session at runtime. There is nothing
to `pip install`, which means it works in virtualenvs, Docker containers, dev
containers and over Remote-SSH without touching your environment or leaving
anything on disk.

## Settings

| Setting | Default | |
|---|---|---|
| `pythonDebugVisualizer.maxPoints` | 20000 | Points transferred per series before downsampling. Statistics ignore this. |
| `pythonDebugVisualizer.autoRefresh` | true | Re-evaluate expressions each time the debugger stops. |
| `pythonDebugVisualizer.historyDepth` | 20 | Past captures kept per expression. |

Bin count, point budget, log scales, colormap and the x axis are set per pane,
in the row under its header — they belong to one question rather than to the
workspace.

## Plotting several things together

Each expression is one pane, so combining values means making the expression
produce them:

```python
{"raw": noisy, "smoothed": smoothed}   # a dict, no library needed
prices[["close", "sma20"]]             # DataFrame columns
np.column_stack([a, b])                # a narrow array
```

You can also **pin** a capture and keep stepping: later values are drawn against
the pinned one, with a count of how many points actually moved.

## Requirements

VS Code 1.89 or newer, and a Python debug session using `debugpy` — the debugger
that ships with the official Python extension.

## Status

Early development, but the core works: every view above, the library adapters,
step-to-step comparison, zoom-to-refine, and a binary side channel for arrays
too large to send inline.

Not yet verified against a real Remote-SSH or dev-container setup. The design is
built for it — the extension host and the debuggee are the same machine there,
which is why the socket goes between *those two* and never from the webview —
but that is reasoning, not a measurement. Reports from remote setups are
especially welcome on
[GitHub](https://github.com/JanLucasK/Python-Debug-Visualizer/issues).

## License

MIT
