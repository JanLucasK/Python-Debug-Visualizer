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

## Requirements

VS Code 1.89 or newer, and a Python debug session using `debugpy` — the debugger
that ships with the official Python extension.

## Status

Early development, but the core works: all the views above, the library
adapters, and step-to-step comparison. Still to come are a binary transport for
very large arrays and a multi-pane layout. Bug reports and ideas are welcome on
[GitHub](https://github.com/JanLucasK/python-debug-visualizer/issues).

## License

MIT
