# Trying everything out

Run **Debug the demo script**, then open the visualizer with
`Ctrl+Shift+P` → *Python Debug Visualizer: Open Visualizer*.

Two breakpoints in [demo.py](demo.py) are worth using. Both are marked in the
source:

- **Breakpoint 1**, inside the loop in `smooth_with_outliers` — for stepping,
  pinning and comparing.
- **Breakpoint 2**, the last line of `main` — everything else is in scope.

Each table below says what to type and what should happen. If something does
not match, that is a bug worth reporting.

---

## Lines and gaps — breakpoint 2

| Type this | Expect |
|---|---|
| `signal` | One clean wave. Stats show `shape (5000)`, `dtype float64` |
| `noisy` | The same wave with noise, **a visible gap at x ≈ 2000**, and `NaN 40` in the stats |
| `noisy` | Also `max 12`, `min -9.5` — single outliers the plot is too coarse to show, but the numbers are real |
| `smoothed` | A step function, with the gap carried through |
| `residual_1d` | What the filter removed. Straddles zero |
| `plain_list` | A plain Python list plots exactly like an array |

The gap is the interesting one: downsampling switches from LTTB to min/max when
a series contains NaN, precisely so holes do not get closed.

## Several series in one plot — breakpoint 2

| Type this | Expect |
|---|---|
| `{"raw": noisy, "smoothed": smoothed}` | Two lines, a legend, one shared x axis |
| `{"noisy": noisy, "smooth": smoothed, "diff": residual_1d}` | Three lines |
| `np.column_stack([signal, smoothed])` | A narrow matrix drawn as two lines |
| `prices[["close", "sma20"]]` | Two columns over a **real date axis** |
| `prices` | Three numeric columns, and a warning that `ticker` was skipped |

## Choosing the visualization — breakpoint 2

Use the dropdown in the pane header.

| Value | Try |
|---|---|
| `skewed` | **Histogram** — a long right tail; bins adapt to the spread |
| `noisy` | **Histogram** — the count says 5000 while the bars sum to 4960, and the pane says why |
| `field` | **Heatmap** — all positive, so a single-hue map |
| `residual` | **Heatmap** — straddles zero, so a diverging map centred on zero, with a hard bright square at ≈ (93, 143) |
| `picture` | **Image** — a colour gradient |
| `transparent` | **Image** — fading to transparent over a checkerboard |
| `prices` | **Table** — dates as dates, not epoch milliseconds |
| `field` | **Table** — 200 rows × 300 columns, virtualised; the first 60 columns are shown and it says so |

## Options — breakpoint 2

The row under the pane header. Options belong to the pane, so two panes can
disagree.

| Try | Expect |
|---|---|
| `exponential`, tick **log y** | A straight line |
| `skewed` as Histogram, set **bins** to `10`, then `200` | Bar count follows |
| `residual` as Heatmap, change **colours** | The choice survives stepping |
| `huge`, set **max points** to `500` | The plot coarsens; the statistics do not change |
| `signal` with **x** = `t` | Plotted against real time instead of sample number |
| `prices["close"]` with **x** = `prices["volume"]` | Price against volume — a scatter of one column against another |
| Any pane, **x** = `np.arange(len(signal)) * 0.01` | An arbitrary expression works as an axis |

## Zoom — breakpoint 2

| Try | Expect |
|---|---|
| Plot `huge`, drag-select a narrow range | The zoom **stays**, and `zoom` plus `in view` appear in the stats |
| Look at `shown` before and after | Same point budget, spent inside the window: the curve gains detail rather than losing points |
| Compare `max` with `in view` | The overall maximum does not change. The window's own numbers sit beside it |
| Double-click, or press **reset zoom** | Back to the whole range |
| `{"raw": noisy, "smoothed": smoothed}`, then zoom | **Both** lines stay aligned and equal in length |

Statistics never move with the view. That is the entire reason they can be
trusted, so the window gets its own numbers rather than redefining theirs.

## Stepping, pinning and comparing — breakpoint 1

Move the breakpoint into the loop in `smooth_with_outliers`, then:

| Step | Expect |
|---|---|
| Plot `smoothed`, press `F10` a few times | The step function builds up from the left |
| Press **pin**, then step again | The pinned curve stays as a dashed line |
| Read the chip | `N of M changed · max |Δ| …` — only the points that actually moved |
| Press `◀` | Step back through kept captures. The position turns amber, because viewing history is a mode |
| Plot `chunk` and step | A 25-sample window sliding along |
| Plot `{"noisy": noisy[start:start+200], "smoothed": smoothed[start:start+200]}` | Both, following the loop |

## Numbers and edge cases — breakpoint 2

| Type this | Expect |
|---|---|
| `booleans` | A 0/1 line — a mask over time |
| `integers` | int64, plotted exactly |
| `big_integers` | A warning that values beyond 2⁵³ are rounded for display |
| `tensor` | A torch tensor with `requires_grad` — readable, and `torch.Tensor` in the stats, not `ndarray` |
| `tensor.detach() * 2` | Ordinary tensor arithmetic works |
| `huge` | 2 million points; downsampled, and it says by which method |

## Things it should decline, politely — breakpoint 2

None of these should error. Each should say what it is and what to do instead.

| Type this | Expect |
|---|---|
| `awkward["complex"]` | "Try np.abs(x), x.real or x.imag" |
| `np.abs(awkward["complex"])` | …and that works |
| `awkward["text"]` | Suggests `np.unique(x, return_counts=True)` |
| `awkward["cube"]` | 4-D: says to slice, e.g. `x[0]` |
| `awkward["cube"][0, 0]` | …and that works |
| `awkward["objects"]` | A dict of non-numbers: described, not plotted |
| `awkward["mixed_list"]` | Reports the non-numeric element |
| `awkward["empty"]` | An empty array does not crash |
| `awkward["all_nan"]` | Reports that there is nothing finite to bin |
| `undefined_name` | A Python `NameError`, shown as an error card |
| `1/0` | A traceback in the card, and the debug session keeps running |

That last pair matters as much as the rest: a tool that can break the program
you are debugging is worse than no tool.
