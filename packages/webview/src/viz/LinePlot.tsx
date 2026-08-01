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
}

/**
 * Line and multi-line plot.
 *
 * uPlot is used rather than a heavier charting library because this renders
 * while someone is stepping through a debugger: the plot is redrawn on every
 * stop, so redraw cost is felt directly. It also takes typed arrays without a
 * conversion pass, which is what the binary channel format was shaped for.
 */
export function LinePlot({ descriptor, decoded, height = 240 }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);

  const series = useMemo(() => collectSeries(descriptor, decoded), [descriptor, decoded]);

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
      plot.current = createPlot(element, latest.current, height);
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
  }, [height, structure]);

  useEffect(() => {
    if (!plot.current || series.length === 0) return;
    plot.current.setData(toPlotData(series));
  }, [series]);

  if (series.length === 0) {
    return <div className="notice warning">Nothing numeric to plot in this value.</div>;
  }

  return <div ref={container} />;
}

interface Series {
  label: string;
  values: Float64Array;
  x: Float64Array;
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

  return series.slice(0, MAX_SERIES);
}

function labelFor(descriptor: Descriptor, channelName: string): string {
  if (channelName !== "y") return channelName;
  // A lone unnamed series is the common case; naming it after the dtype at
  // least makes the legend say something useful.
  return descriptor.dtype ?? "value";
}

function toPlotData(series: Series[]): uPlot.AlignedData {
  const x = series[0]?.x ?? new Float64Array(0);
  return [x, ...series.map((s) => s.values)] as unknown as uPlot.AlignedData;
}

function createPlot(container: HTMLDivElement, series: Series[], height: number): uPlot {
  const theme = readTheme();
  const width = container.clientWidth || 600;

  const options: uPlot.Options = {
    width,
    height,
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
    scales: { x: { time: false } },
    axes: [
      { stroke: theme.axis, grid: { stroke: theme.grid, width: 1 }, ticks: { stroke: theme.grid } },
      { stroke: theme.axis, grid: { stroke: theme.grid, width: 1 }, ticks: { stroke: theme.grid } },
    ],
    series: [
      { label: "index" },
      ...series.map((s, index) => ({
        label: s.label,
        stroke: seriesColor(theme, index),
        width: 2,
        // Gaps are drawn as gaps. A NaN means "no value here", and joining
        // across it would invent a line the data does not support.
        spanGaps: false,
        points: { show: s.values.length <= 200 },
      })),
    ],
  };

  return new uPlot(options, toPlotData(series), container);
}
