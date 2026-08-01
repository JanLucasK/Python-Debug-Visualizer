# Screenshots

Referenced from the two READMEs. The extension README uses **absolute**
`raw.githubusercontent.com` URLs, because the Marketplace does not resolve
relative image paths — a relative link there renders as a broken image.

| File | Shows | Expression |
|---|---|---|
| `01-two-series.png` | Two arrays overlaid from one dict, with a NaN gap and outliers | `{"raw": noisy, "smoothed": smoothed}` |
| `02-matrix-lines.png` | A narrow matrix drawn as one line per column | `np.column_stack([signal, smoothed])` |
| `03-histogram.png` | Distribution, binned in the debuggee, non-finite values reported | same, as Histogram |
| `04-table.png` | The numbers themselves, virtualised | same, as Table |
| `05-dataframe.png` | A DataFrame on a DatetimeIndex, non-numeric column reported | `prices` |
| `06-heatmap.png` | The same frame as a colour matrix, with its scale | same, as Heatmap |

Keep the file names: both READMEs point at them.
