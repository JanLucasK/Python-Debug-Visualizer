import type { Descriptor } from "@python-debug-visualizer/protocol";
import { useLayoutEffect, useMemo, useRef } from "preact/hooks";
import type { DecodedCapture } from "../decode";
import {
  COLORMAP_NAMES,
  type ColormapName,
  DIVERGING_COLORMAPS,
  lookupTable,
  sampleColormap,
} from "./colormaps";

interface Props {
  descriptor: Descriptor;
  decoded: DecodedCapture;
  maxHeight?: number;
  /** From the pane's options, so the choice survives a debugger step. */
  colormap?: string;
}

/** Non-finite cells get their own colour instead of being folded into the range. */
const NON_FINITE_RGB: readonly [number, number, number] = [120, 120, 120];

/**
 * Two-dimensional array as a colour matrix.
 *
 * Rendered to a canvas at one pixel per cell and then scaled up with smoothing
 * disabled. Interpolating would blend neighbouring cells into values that are
 * not in the array — visually smoother, and wrong. A single anomalous cell
 * staying a single hard square is the entire reason to look at a heatmap while
 * debugging.
 */
export function Heatmap({ descriptor, decoded, maxHeight = 420, colormap: chosen }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const colormap = isColormap(chosen) ? chosen : defaultColormap(descriptor);

  const grid = useMemo(() => collectGrid(descriptor, decoded), [descriptor, decoded]);
  const range = useMemo(() => resolveRange(descriptor, colormap), [descriptor, colormap]);

  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element || !grid || !range) return;

    element.width = grid.cols;
    element.height = grid.rows;

    const context = element.getContext("2d");
    if (!context) return;

    context.putImageData(paint(grid, range, colormap), 0, 0);
    // Set after painting: it governs how the browser scales the canvas up to
    // its CSS size, which is where interpolation would otherwise creep in.
    element.style.imageRendering = "pixelated";
  }, [grid, range, colormap]);

  if (!grid) {
    return <div className="notice warning">This capture has no 2-D values to draw.</div>;
  }
  if (!range) {
    return (
      <div className="notice warning">
        Every value is NaN or Inf, so there is no range to colour.
      </div>
    );
  }

  return (
    <div className="heatmap">
      <div className="heatmap-canvas-wrap" style={{ maxHeight }}>
        <canvas ref={canvas} className="heatmap-canvas" aria-label="Heatmap" />
      </div>
      <div className="heatmap-footer">
        <ColorBar colormap={colormap} low={range.low} high={range.high} />
      </div>
    </div>
  );
}

interface Grid {
  rows: number;
  cols: number;
  values: Float64Array;
}

interface Range {
  low: number;
  high: number;
}

function collectGrid(descriptor: Descriptor, decoded: DecodedCapture): Grid | undefined {
  const shape = descriptor.shape;
  if (!shape || shape.length !== 2) return undefined;

  const channel = decoded.channels.get("value") ?? decoded.channels.get("y");
  if (!channel) return undefined;

  const [rows, cols] = shape as [number, number];
  if (channel.values.length < rows * cols) return undefined;

  return { rows, cols, values: channel.values };
}

/**
 * The colour range.
 *
 * Diverging maps are forced symmetric around zero, because their whole premise
 * is that the midpoint means "neither". Letting the midpoint drift to whatever
 * happens to be halfway between min and max would put grey somewhere
 * meaningless and make positive and negative deviations incomparable.
 */
function resolveRange(descriptor: Descriptor, colormap: ColormapName): Range | undefined {
  const stats = descriptor.stats;
  if (!stats || stats.min === null || stats.max === null) return undefined;

  if (DIVERGING_COLORMAPS.has(colormap)) {
    const extent = Math.max(Math.abs(stats.min), Math.abs(stats.max)) || 1;
    return { low: -extent, high: extent };
  }
  if (stats.min === stats.max) {
    return { low: stats.min - 0.5, high: stats.max + 0.5 };
  }
  return { low: stats.min, high: stats.max };
}

/** Persisted options are untrusted strings; an unknown name falls back. */
function isColormap(value: string | undefined): value is ColormapName {
  return value !== undefined && (COLORMAP_NAMES as string[]).includes(value);
}

function defaultColormap(descriptor: Descriptor): ColormapName {
  const stats = descriptor.stats;
  // Data straddling zero is usually a difference or a residual, where the sign
  // is the point.
  if (stats && stats.min !== null && stats.max !== null && stats.min < 0 && stats.max > 0) {
    return "coolwarm";
  }
  return "viridis";
}

function paint(grid: Grid, range: Range, colormap: ColormapName): ImageData {
  const table = lookupTable(colormap);
  const image = new ImageData(grid.cols, grid.rows);
  const pixels = image.data;
  const span = range.high - range.low || 1;

  for (let i = 0; i < grid.rows * grid.cols; i++) {
    const value = grid.values[i] as number;
    const target = i * 4;

    if (!Number.isFinite(value)) {
      pixels[target] = NON_FINITE_RGB[0];
      pixels[target + 1] = NON_FINITE_RGB[1];
      pixels[target + 2] = NON_FINITE_RGB[2];
      pixels[target + 3] = 255;
      continue;
    }

    const fraction = Math.max(0, Math.min(1, (value - range.low) / span));
    const entry = Math.round(fraction * 255) * 3;
    pixels[target] = table[entry] as number;
    pixels[target + 1] = table[entry + 1] as number;
    pixels[target + 2] = table[entry + 2] as number;
    pixels[target + 3] = 255;
  }

  return image;
}

/** Without this the colours mean nothing; a heatmap with no scale is decoration. */
function ColorBar({ colormap, low, high }: { colormap: ColormapName } & Range) {
  const stops = Array.from({ length: 16 }, (_, i) => sampleColormap(colormap, i / 15)).join(", ");
  return (
    <div className="colorbar">
      <span className="colorbar-label">{format(low)}</span>
      <div
        className="colorbar-ramp"
        style={{ background: `linear-gradient(to right, ${stops})` }}
      />
      <span className="colorbar-label">{format(high)}</span>
    </div>
  );
}

function format(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude < 1e-3 || magnitude >= 1e5)) return value.toExponential(2);
  return Number(value.toPrecision(4)).toString();
}
