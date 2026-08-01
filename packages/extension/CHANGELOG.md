# Changelog

## 0.1.0

First release.

### Plotting

- **Six views**, chosen per pane or suggested from the value: line, scatter,
  histogram, heatmap, image and a virtualised table.
- **Several series in one plot** from a dict, a DataFrame, or a narrow array —
  `{"raw": a, "smoothed": b}` needs no library at all.
- **Any expression as the x axis**, so one quantity can be plotted against
  another rather than against its index.
- **Log scales**, per-pane bin counts, colormaps and point budgets.

### Values

NumPy arrays (1-D, 2-D, and H×W×3/4 as images), Pandas DataFrames, Series and
indexes, PyTorch and TensorFlow tensors, dicts of arrays, lists and scalars.

Tensors are handled properly rather than nominally: `requires_grad` is readable,
CUDA tensors are copied without disturbing the program, `bfloat16` widens rather
than failing, and sparse tensors are described rather than densified into memory
you may not have.

Anything that cannot be plotted is described — type, shape and repr — with a
note on what to try instead.

### Comparing across steps

Each pane keeps its recent captures. Scrub back through them, pin one, and later
steps are drawn against it with a count of how many points actually moved.
Comparison aligns on x positions rather than array index, because two captures
of one expression may have been downsampled differently.

### Honesty

- Statistics always describe the **whole** value, even when the plot is
  downsampled or zoomed. A zoom carries its own numbers alongside rather than
  redefining theirs.
- Downsampling switches from LTTB to min/max when a series contains NaN, so gaps
  stay visible instead of being quietly closed.
- Skipped columns, stretched heatmap cells, dropped series and rounded integers
  are all reported rather than left to be noticed.

### Under the hood

- **Nothing to install in your project.** The Python runtime is injected into
  the debug session, so it works in virtualenvs, containers and over SSH.
- **No 64 KiB limit.** Captures are read in `clipboard` context with
  `rawString`, the two independent bypasses of debugpy's truncation — both
  measured against a real session rather than assumed.
- **Three transports**, tried in order: inline, a loopback socket, and a temp
  file. Every failure falls to the next, so a transport problem never becomes a
  failed capture.
- **Zoom re-captures** inside the visible range, spending the point budget on
  what is on screen.

### Known gaps

- Not yet run against a real Remote-SSH or dev-container setup. The design is
  built for them and the reasoning is documented, but that is not a measurement.
- Scatter takes one series against the x axis, not several x/y pairs.
- No export of plots or data.
