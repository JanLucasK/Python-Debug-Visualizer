import type { Descriptor } from "@python-debug-visualizer/protocol";
import { useEffect, useLayoutEffect, useMemo, useRef } from "preact/hooks";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { DecodedCapture } from "../decode";
import { onThemeChange, readTheme, seriesColor } from "../theme";

interface Props {
  descriptor: Descriptor;
  decoded: DecodedCapture;
  height?: number;
}

/**
 * Distribution of a value's elements.
 *
 * The bins arrive pre-computed from Python. That is not an optimisation
 * detail — binning five million points in the webview would mean transferring
 * five million points first, so where the arithmetic happens decides what
 * crosses the wire.
 */
export function Histogram({ descriptor, decoded, height = 240 }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);

  const bins = useMemo(() => collectBins(decoded), [decoded]);

  const latest = useRef(bins);
  latest.current = bins;

  // biome-ignore lint/correctness/useExhaustiveDependencies: bin count is a change token; values are read through a ref
  useLayoutEffect(() => {
    const element = container.current;
    if (!element || latest.current === undefined) return;

    const build = () => {
      plot.current?.destroy();
      plot.current = createPlot(element, latest.current as Bins, height, descriptor);
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
  }, [height, bins?.counts.length, descriptor.dtype]);

  useEffect(() => {
    if (plot.current && bins) plot.current.setData(toPlotData(bins));
  }, [bins]);

  if (!bins) {
    return <div className="notice warning">No bins in this capture.</div>;
  }

  return <div ref={container} />;
}

interface Bins {
  /** Bin boundaries; always one longer than `counts`. */
  edges: Float64Array;
  counts: Float64Array;
}

function collectBins(decoded: DecodedCapture): Bins | undefined {
  const edges = decoded.channels.get("binEdge")?.values;
  const counts = decoded.channels.get("binCount")?.values;
  if (!edges || !counts || counts.length === 0 || edges.length !== counts.length + 1) {
    return undefined;
  }
  return { edges, counts };
}

/** Bars are positioned at bin centres, so a bar covers the range it counts. */
function toPlotData(bins: Bins): uPlot.AlignedData {
  const centres = new Float64Array(bins.counts.length);
  for (let i = 0; i < centres.length; i++) {
    centres[i] = ((bins.edges[i] as number) + (bins.edges[i + 1] as number)) / 2;
  }
  return [centres, bins.counts] as unknown as uPlot.AlignedData;
}

function createPlot(
  container: HTMLDivElement,
  bins: Bins,
  height: number,
  descriptor: Descriptor,
): uPlot {
  const theme = readTheme();

  const options: uPlot.Options = {
    width: container.clientWidth || 600,
    height,
    legend: { show: false }, // one series; the pane header already names it
    cursor: { drag: { x: true, y: false }, focus: { prox: 16 } },
    scales: { x: { time: false } },
    axes: [
      {
        stroke: theme.axis,
        grid: { stroke: theme.grid, width: 1 },
        ticks: { stroke: theme.grid },
        label: descriptor.dtype ?? "value",
        labelSize: 20,
      },
      {
        stroke: theme.axis,
        grid: { stroke: theme.grid, width: 1 },
        ticks: { stroke: theme.grid },
        label: "count",
        labelSize: 20,
      },
    ],
    series: [
      { label: "value" },
      {
        label: "count",
        stroke: seriesColor(theme, 0),
        fill: seriesColor(theme, 0),
        // `size: [1]` lets bars fill the spacing between centres, leaving the
        // 2px gap that keeps adjacent bars readable as separate marks.
        paths: uPlot.paths.bars?.({ size: [1, Number.POSITIVE_INFINITY, 2], align: 0 }),
        points: { show: false },
      },
    ],
  };

  return new uPlot(options, toPlotData(bins), container);
}
