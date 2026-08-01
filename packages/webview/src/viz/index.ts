/**
 * Registration of the built-in visualizations.
 *
 * Kept apart from `registry.ts` so the registry has no dependency on any
 * particular renderer. That is what would let a third party contribute one
 * later without the registry needing to know it exists.
 */

import { DataGrid } from "./DataGrid";
import { Heatmap } from "./Heatmap";
import { Histogram } from "./Histogram";
import { LinePlot } from "./LinePlot";
import { ObjectPreview } from "./ObjectPreview";
import { hasNumericData, isOneDimensional, isTwoDimensional, registerViz } from "./registry";

registerViz({
  kind: "line",
  label: "Line",
  available: (descriptor) => hasNumericData(descriptor) && isOneDimensional(descriptor),
  component: ({ descriptor, decoded }) => LinePlot({ descriptor, decoded }),
});

registerViz({
  kind: "scatter",
  label: "Scatter",
  available: (descriptor) => hasNumericData(descriptor) && isOneDimensional(descriptor),
  component: ({ descriptor, decoded }) => LinePlot({ descriptor, decoded, mode: "scatter" }),
});

registerViz({
  kind: "histogram",
  label: "Histogram",
  // Any numeric value can be binned, including a 2-D one -- the runtime
  // flattens it first.
  available: hasNumericData,
  // Bins are not points: choosing this asks Python for a different capture.
  needsOwnCapture: true,
  component: Histogram,
});

registerViz({
  kind: "heatmap",
  label: "Heatmap",
  available: (descriptor) => hasNumericData(descriptor) && isTwoDimensional(descriptor),
  component: Heatmap,
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
