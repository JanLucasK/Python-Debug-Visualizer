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
  /**
   * Whether selecting this kind requires re-asking Python.
   *
   * True when the visualization needs channels the current capture does not
   * carry, which is what tells the extension a re-capture is due.
   */
  needsOwnCapture?: boolean;
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
