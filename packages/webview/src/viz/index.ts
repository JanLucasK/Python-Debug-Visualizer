/**
 * Registration of the built-in visualizations.
 *
 * Kept apart from `registry.ts` so the registry has no dependency on any
 * particular renderer. That is what would let a third party contribute one
 * later without the registry needing to know it exists.
 */

import { MAX_SERIES } from "../theme";
import { DataGrid } from "./DataGrid";
import { Heatmap } from "./Heatmap";
import { Histogram } from "./Histogram";
import { ImageView } from "./ImageView";
import { LinePlot } from "./LinePlot";
import { ObjectPreview } from "./ObjectPreview";
import {
  hasNumericData,
  isNarrowMatrix,
  isOneDimensional,
  isSeriesLike,
  isTwoDimensional,
  registerViz,
} from "./registry";

/**
 * Values the line and scatter renderers can draw.
 *
 * Judged from `kind` rather than shape, because shape alone cannot tell a
 * DataFrame from a matrix — both report [rows, columns], and one wants lines
 * where the other wants a heatmap.
 */
const plottableAsSeries = (descriptor: Parameters<typeof hasNumericData>[0]) =>
  hasNumericData(descriptor) &&
  (isSeriesLike(descriptor) ||
    (descriptor.kind === "ndarray" &&
      (isOneDimensional(descriptor) || isNarrowMatrix(descriptor, MAX_SERIES))));

registerViz({
  kind: "line",
  label: "Line",
  available: plottableAsSeries,
  component: ({ descriptor, decoded }) => LinePlot({ descriptor, decoded }),
});

registerViz({
  kind: "scatter",
  label: "Scatter",
  available: plottableAsSeries,
  component: ({ descriptor, decoded }) => LinePlot({ descriptor, decoded, mode: "scatter" }),
});

registerViz({
  kind: "histogram",
  label: "Histogram",
  // Any numeric value can be binned, including a 2-D one -- the runtime
  // flattens it first.
  available: hasNumericData,
  component: Histogram,
});

registerViz({
  kind: "heatmap",
  label: "Heatmap",
  // Only a raw matrix. A DataFrame is also [rows, columns], but its columns
  // are unrelated quantities, and colouring them on one scale would compare
  // prices against volumes.
  available: (descriptor) =>
    hasNumericData(descriptor) && descriptor.kind === "ndarray" && isTwoDimensional(descriptor),
  component: Heatmap,
});

registerViz({
  kind: "image",
  label: "Image",
  available: (descriptor) =>
    descriptor.shape?.length === 3 && (descriptor.shape[2] === 3 || descriptor.shape[2] === 4),
  component: ImageView,
});

registerViz({
  kind: "grid",
  label: "Table",
  available: (descriptor) => descriptor.channels.length > 0 || descriptor.columns !== null,
  component: DataGrid,
});

registerViz({
  kind: "tree",
  label: "Value",
  // The last resort, and therefore always available: whatever the value turned
  // out to be, its repr and statistics can be shown.
  available: () => true,
  component: ObjectPreview,
});

export { availableViz, findViz, resolveViz } from "./registry";
export type { VizDefinition, VizProps } from "./registry";
