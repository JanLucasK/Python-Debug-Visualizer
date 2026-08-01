import type { Descriptor, VizKind } from "@python-debug-visualizer/protocol";
import type { ComponentType } from "preact";
import type { DecodedCapture } from "../decode";

export interface VizProps {
  descriptor: Descriptor;
  decoded: DecodedCapture;
}

export interface VizDefinition {
  kind: VizKind;
  label: string;
  /**
   * Whether this visualization makes sense for the *value*, judged from its
   * kind, shape and statistics.
   *
   * Deliberately not judged from the channels present. Some visualizations ask
   * Python for different channels -- a histogram gets bin counts instead of
   * points -- so a channel-based test would make every other option vanish the
   * moment one of them was selected, leaving no way back.
   */
  available(descriptor: Descriptor): boolean;
  component: ComponentType<VizProps>;
}

const definitions: VizDefinition[] = [];

export function registerViz(definition: VizDefinition): void {
  definitions.push(definition);
}

export function availableViz(descriptor: Descriptor): VizDefinition[] {
  return definitions.filter((definition) => definition.available(descriptor));
}

export function findViz(kind: VizKind): VizDefinition | undefined {
  return definitions.find((definition) => definition.kind === kind);
}

/**
 * The visualization to show, given the user's choice.
 *
 * `"auto"` follows the adapter's ranked suggestion, since Python knows what it
 * just looked at. An explicit choice is honoured even when it is unusual --
 * plotting a 2-D array as overlaid lines is occasionally exactly what someone
 * wants -- and only overridden if the value cannot support it at all.
 */
export function resolveViz(
  descriptor: Descriptor,
  chosen: VizKind | "auto",
): VizDefinition | undefined {
  const usable = availableViz(descriptor);
  if (usable.length === 0) return undefined;

  if (chosen !== "auto") {
    const requested = usable.find((definition) => definition.kind === chosen);
    if (requested) return requested;
  }

  for (const suggestion of descriptor.suggestedViz) {
    const suggested = usable.find((definition) => definition.kind === suggestion);
    if (suggested) return suggested;
  }
  return usable[0];
}

/** True when the value has numbers worth summarising. */
export function hasNumericData(descriptor: Descriptor): boolean {
  return descriptor.stats !== null && descriptor.stats.count > 0;
}

export function isOneDimensional(descriptor: Descriptor): boolean {
  return descriptor.shape !== null && descriptor.shape.length === 1;
}

export function isTwoDimensional(descriptor: Descriptor): boolean {
  return descriptor.shape !== null && descriptor.shape.length === 2;
}

/**
 * Values that are a set of named series sharing one index.
 *
 * The distinction cannot be made from shape alone, which is why `kind` exists.
 * A DataFrame and a 2-D array both report `[rows, columns]`, but one is four
 * named quantities over time and the other is a matrix — plotting the first as
 * a heatmap and the second as four lines are both wrong.
 */
export function isSeriesLike(descriptor: Descriptor): boolean {
  return (
    descriptor.kind === "frame" ||
    descriptor.kind === "series" ||
    descriptor.kind === "mapping" ||
    descriptor.kind === "sequence" ||
    descriptor.kind === "index"
  );
}

/**
 * A raw array that can be drawn as one line per column.
 *
 * `np.column_stack([a, b])` is a natural way to ask for two lines, and without
 * this it would only ever be a heatmap.
 */
export function isNarrowMatrix(descriptor: Descriptor, maxColumns: number): boolean {
  return (
    descriptor.kind === "ndarray" &&
    isTwoDimensional(descriptor) &&
    (descriptor.shape?.[1] ?? Number.POSITIVE_INFINITY) <= maxColumns
  );
}
