import type { Descriptor } from "@python-debug-visualizer/protocol";
import { useEffect, useLayoutEffect, useMemo, useRef } from "preact/hooks";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { type DecodedCapture, xValuesFor } from "../decode";
import { MAX_SERIES, onThemeChange, readTheme, seriesColor } from "../theme";

interface Props {
  descriptor: Descriptor;
  decoded: DecodedCapture;
  height?: number;
  /** `"scatter"` draws the same series as unconnected points. */
  mode?: "line" | "scatter";
  /** A pinned earlier capture, drawn underneath for comparison. */
  reference?: { descriptor: Descriptor; decoded: DecodedCapture };
}

/**
 * Line, multi-line and scatter plot.
 *
 * uPlot is used rather than a heavier charting library because this renders
 * while someone is stepping through a debugger: the plot is redrawn on every
 * stop, so redraw cost is felt directly. It also takes typed arrays without a
 * conversion pass, which is what the binary channel format was shaped for.
 *
 * Scatter shares this component rather than getting its own, because the two
 * differ by one series option. Splitting them would mean maintaining the axis,
 * theme, resize and rebuild logic twice.
 */
export function LinePlot({ descriptor, decoded, height = 240, mode = "line", reference }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);

  const { shown: series, hidden } = useMemo(() => {
    const current = collectSeries(descriptor, decoded);
    if (!reference) return seriesOverflow(current);

    // The pinned capture is drawn on the same axes so the two can be read
    // against each other directly. It keeps its counterpart's colour and is
    // distinguished by being dashed and thinner, which leaves the colour free
    // to mean "which series" rather than "which snapshot".
    // Half the slots each, so pinning never pushes current series off the plot.
    const room = Math.floor(MAX_SERIES / 2);
    const past = collectSeries(reference.descriptor, reference.decoded)
      .slice(0, room)
      .map((entry, index) => ({
        ...entry,
        label: `${entry.label} (pinned)`,
        colorIndex: index,
        dimmed: true,
      }));
    return {
      shown: [...current.slice(0, room), ...past],
      hidden: Math.max(0, current.length - room),
    };
  }, [descriptor, decoded, reference]);

  /**
   * Identity of the plot's *structure* — series names and point counts.
   *
   * Recreating a uPlot instance is expensive and throws away the user's zoom,
   * so it happens only when the structure actually changes. Value updates take
   * the cheap `setData` path below, which is what keeps stepping through a loop
   * smooth.
   */
  const structure = useMemo(
    () => series.map((s) => `${s.label}:${s.values.length}`).join("|"),
    [series],
  );

  // Read through a ref so the rebuild effect never closes over `series`, and
  // therefore does not need it as a dependency.
  const latest = useRef(series);
  latest.current = series;

  /**
   * Whether the x axis carries timestamps rather than positions.
   *
   * Only true when the runtime actually sent index values: a DatetimeIndex that
   * fell back to positions would otherwise have its point numbers formatted as
   * dates in 1970.
   */
  const timeAxis =
    descriptor.index?.kind === "datetime" &&
    descriptor.index.timeUnit === "ms" &&
    decoded.channels.has("x");

  // A layout effect so the chart is sized before paint, avoiding a visible jump
  // on the first frame after every debugger step.
  //
  // `structure` is listed as a dependency deliberately: it is a change token
  // rather than a value the effect reads, so that a change in series names or
  // lengths rebuilds the plot while a change in the numbers alone does not.
  // The data itself is reached through a ref, which is why it is absent here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: structure is a change token, see above
  useLayoutEffect(() => {
    const element = container.current;
    if (!element || latest.current.length === 0) return;

    const build = () => {
      plot.current?.destroy();
      plot.current = createPlot(element, latest.current, height, mode, timeAxis);
    };

    build();
    const stopWatchingTheme = onThemeChange(build);

    const resize = new ResizeObserver(([entry]) => {
      if (entry && plot.current) {
        plot.current.setSize({ width: entry.contentRect.width, height });
      }
    });
    resize.observe(element);

    return () => {
      stopWatchingTheme();
      resize.disconnect();
      plot.current?.destroy();
      plot.current = null;
    };
  }, [height, structure, mode, timeAxis]);

  useEffect(() => {
    if (!plot.current || series.length === 0) return;
    plot.current.setData(toPlotData(series));
  }, [series]);

  if (series.length === 0) {
    return <div className="notice warning">Nothing numeric to plot in this value.</div>;
  }

  return (
    <>
      <div ref={container} />
      {hidden > 0 && (
        <p className="notice warning">
          {hidden} further series {hidden === 1 ? "is" : "are"} not drawn: the palette has{" "}
          {MAX_SERIES} distinguishable colours. Select the columns you want, for example{" "}
          <code>df[["a", "b"]]</code>.
        </p>
      )}
    </>
  );
}

interface Series {
  label: string;
  values: Float64Array;
  x: Float64Array;
  /** Colour slot; lets a pinned series share its counterpart's colour. */
  colorIndex?: number;
  /** Drawn dashed and thinner, so the current data stays in front. */
  dimmed?: boolean;
}

function collectSeries(descriptor: Descriptor, decoded: DecodedCapture): Series[] {
  const series: Series[] = [];

  for (const channel of descriptor.channels) {
    if (channel.role !== "y") continue;
    const decodedChannel = decoded.channels.get(channel.name);
    if (!decodedChannel) continue;

    series.push({
      label: labelFor(descriptor, channel.name),
      values: decodedChannel.values,
      x: xValuesFor(decoded, decodedChannel.values.length),
    });
  }

  // A raw matrix arrives as one flat channel, because that is what the heatmap
  // wants. Drawing it as one line per column is the other reasonable reading of
  // the same bytes -- `np.column_stack([a, b])` is a natural way to ask for two
  // lines -- so the columns are sliced out here rather than sent twice.
  if (series.length === 0) {
    series.push(...columnsOfMatrix(descriptor, decoded));
  }

  return series;
}

function columnsOfMatrix(descriptor: Descriptor, decoded: DecodedCapture): Series[] {
  const shape = descriptor.shape;
  if (descriptor.kind !== "ndarray" || !shape || shape.length !== 2) return [];

  const flat = decoded.channels.get("value");
  if (!flat) return [];

  const [rows, cols] = shape as [number, number];
  const series: Series[] = [];

  for (let column = 0; column < Math.min(cols, MAX_SERIES); column++) {
    const values = new Float64Array(rows);
    for (let row = 0; row < rows; row++) {
      values[row] = flat.values[row * cols + column] as number;
    }
    series.push({ label: `col ${column}`, values, x: positions(rows) });
  }

  return series;
}

function positions(length: number): Float64Array {
  const values = new Float64Array(length);
  for (let i = 0; i < length; i++) values[i] = i;
  return values;
}

/**
 * Series the palette cannot distinguish.
 *
 * The categorical palette has eight slots and is never cycled, because a ninth
 * generated hue would fail the contrast and colour-vision checks the eight
 * passed. So beyond eight, series are dropped — and dropping them quietly would
 * leave someone comparing four columns of a twelve-column frame while believing
 * they were looking at all of it.
 */
function seriesOverflow(series: Series[]): { shown: Series[]; hidden: number } {
  return { shown: series.slice(0, MAX_SERIES), hidden: Math.max(0, series.length - MAX_SERIES) };
}

function labelFor(descriptor: Descriptor, channelName: string): string {
  if (channelName !== "y") return channelName;
  // A lone unnamed series is the common case; naming it after the dtype at
  // least makes the legend say something useful.
  return descriptor.dtype ?? "value";
}

/**
 * Series laid onto one shared x axis, which is what uPlot requires.
 *
 * When a pinned capture is overlaid the two may not share x positions at all —
 * decimation picks whichever points best preserve each curve. Handing uPlot the
 * current capture's x array and the pinned capture's values would draw the
 * pinned data at positions it never had, which is the same misalignment the
 * diff module exists to avoid, except silent and on screen.
 *
 * So the axis becomes the union of both, and each series is projected onto it
 * with gaps where it has no point. The common case — one capture, one x array —
 * skips all of this.
 */
function toPlotData(series: Series[]): uPlot.AlignedData {
  if (series.length === 0) return [[]] as unknown as uPlot.AlignedData;

  const reference = series[0]?.x as Float64Array;
  const shared = series.every((s) => s.x === reference || sameAxis(s.x, reference));
  if (shared) {
    return [reference, ...series.map((s) => s.values)] as unknown as uPlot.AlignedData;
  }

  const axis = unionOf(series.map((s) => s.x));
  return [axis, ...series.map((s) => project(s, axis))] as unknown as uPlot.AlignedData;
}

function sameAxis(a: Float64Array, b: Float64Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function unionOf(axes: Float64Array[]): Float64Array {
  const seen = new Set<number>();
  for (const axis of axes) {
    for (const value of axis) seen.add(value);
  }
  return Float64Array.from(seen).sort();
}

/** Values at the axis positions this series has, and null where it has none. */
function project(series: Series, axis: Float64Array): (number | null)[] {
  const values = new Map<number, number>();
  for (let i = 0; i < series.x.length && i < series.values.length; i++) {
    values.set(series.x[i] as number, series.values[i] as number);
  }
  return Array.from(axis, (position) => values.get(position) ?? null);
}

function createPlot(
  container: HTMLDivElement,
  series: Series[],
  height: number,
  mode: "line" | "scatter",
  timeAxis: boolean,
): uPlot {
  const theme = readTheme();
  const width = container.clientWidth || 600;

  const options: uPlot.Options = {
    width,
    height,
    // uPlot assumes seconds on a time scale. The runtime normalises every
    // datetime index to milliseconds, so it has to be told -- otherwise every
    // timestamp lands in 1970 and the axis looks broken rather than wrong.
    ms: 1,
    // A legend for two or more series is not optional: three light-mode palette
    // slots sit below 3:1 contrast on white, so the labels are what carry
    // identity. A single series needs none — the pane header already names it.
    legend: { show: series.length > 1 },
    cursor: {
      // Drag-zoom on x only. Zooming both axes at once in a debugging context
      // mostly produces a view you cannot find your way out of.
      drag: { x: true, y: false },
      focus: { prox: 16 },
    },
    scales: { x: { time: timeAxis } },
    axes: [
      { stroke: theme.axis, grid: { stroke: theme.grid, width: 1 }, ticks: { stroke: theme.grid } },
      { stroke: theme.axis, grid: { stroke: theme.grid, width: 1 }, ticks: { stroke: theme.grid } },
    ],
    series: [
      { label: timeAxis ? "time" : "index" },
      ...series.map((s, index) => ({
        label: s.label,
        stroke: seriesColor(theme, s.colorIndex ?? index),
        width: s.dimmed ? 1 : 2,
        ...(s.dimmed ? { dash: [4, 4] } : {}),
        // Gaps are drawn as gaps. A NaN means "no value here", and joining
        // across it would invent a line the data does not support.
        spanGaps: false,
        ...(mode === "scatter"
          ? {
              // Suppressing the path leaves the markers, which is what makes
              // this a scatter plot.
              paths: () => null,
              points: { show: true, size: 5 },
            }
          : { points: { show: s.values.length <= 200 } }),
      })),
    ],
  };

  return new uPlot(options, toPlotData(series), container);
}
