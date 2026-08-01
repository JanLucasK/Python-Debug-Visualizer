import type { Descriptor } from "@python-debug-visualizer/protocol";
import { type DecodedCapture, xValuesFor } from "./decode";

/**
 * Comparison of a captured value against an earlier one.
 *
 * The subtle part is alignment. Two captures of the same expression at
 * different debugger steps may have been decimated differently — LTTB picks
 * whichever points best preserve *that* curve's shape, so element 500 of one
 * capture and element 500 of the other are generally not the same element of
 * the underlying array. Subtracting them position by position produces a
 * confident, entirely fictional delta.
 *
 * So comparison is done on x positions, which the runtime sends precisely
 * because decimation makes them non-implicit. Points present in only one of the
 * two are excluded and counted, rather than being compared against nothing.
 */

export interface SeriesDiff {
  name: string;
  /** Points that appear in both captures and could therefore be compared. */
  comparable: number;
  changed: number;
  maxAbsDelta: number;
  meanAbsDelta: number;
  /** Delta at each comparable x, in the current capture's order. */
  delta: Float64Array;
  x: Float64Array;
}

export interface DiffSummary {
  series: SeriesDiff[];
  /** Total points in the current capture that had no counterpart to compare to. */
  unmatched: number;
  shapeChanged: boolean;
  previousShape: number[] | null;
  /** Set when the two captures are not comparable at all. */
  incomparable: string | null;
}

export interface CaptureSide {
  descriptor: Descriptor;
  decoded: DecodedCapture;
}

/** Values closer than this count as unchanged, absorbing float round-trip noise. */
const EPSILON = 0;

export function diffCaptures(current: CaptureSide, reference: CaptureSide): DiffSummary {
  const shapeChanged = !sameShape(current.descriptor.shape, reference.descriptor.shape);

  const currentSeries = valueChannels(current);
  const referenceSeries = valueChannels(reference);

  if (currentSeries.size === 0 || referenceSeries.size === 0) {
    return {
      series: [],
      unmatched: 0,
      shapeChanged,
      previousShape: reference.descriptor.shape,
      incomparable: "One of the two captures carries no numeric values.",
    };
  }

  const currentX = xValuesFor(current.decoded, firstLength(currentSeries));
  const referenceX = xValuesFor(reference.decoded, firstLength(referenceSeries));

  const series: SeriesDiff[] = [];
  let unmatched = 0;

  for (const [name, values] of currentSeries) {
    const previous = referenceSeries.get(name);
    if (!previous) continue;

    const lookup = new Map<number, number>();
    for (let i = 0; i < previous.length && i < referenceX.length; i++) {
      lookup.set(referenceX[i] as number, previous[i] as number);
    }

    const alignedX: number[] = [];
    const alignedDelta: number[] = [];
    let changed = 0;
    let maxAbs = 0;
    let sumAbs = 0;

    for (let i = 0; i < values.length && i < currentX.length; i++) {
      const position = currentX[i] as number;
      const before = lookup.get(position);
      if (before === undefined) {
        unmatched++;
        continue;
      }

      const now = values[i] as number;
      // NaN on either side means "no value", and a delta from nothing is not a
      // number either. Propagating NaN keeps the gap visible instead of
      // inventing a change of zero.
      const delta = Number.isNaN(now) || Number.isNaN(before) ? Number.NaN : now - before;

      alignedX.push(position);
      alignedDelta.push(delta);

      if (!Number.isNaN(delta) && Math.abs(delta) > EPSILON) {
        changed++;
        const magnitude = Math.abs(delta);
        if (magnitude > maxAbs) maxAbs = magnitude;
        sumAbs += magnitude;
      }
    }

    series.push({
      name,
      comparable: alignedDelta.length,
      changed,
      maxAbsDelta: maxAbs,
      meanAbsDelta: changed > 0 ? sumAbs / changed : 0,
      delta: Float64Array.from(alignedDelta),
      x: Float64Array.from(alignedX),
    });
  }

  return {
    series,
    unmatched,
    shapeChanged,
    previousShape: reference.descriptor.shape,
    incomparable:
      series.length === 0 ? "The two captures share no series with the same name." : null,
  };
}

/** Aggregate across series, for the one-line summary in the pane. */
export function totals(summary: DiffSummary): {
  comparable: number;
  changed: number;
  maxAbsDelta: number;
} {
  let comparable = 0;
  let changed = 0;
  let maxAbsDelta = 0;
  for (const entry of summary.series) {
    comparable += entry.comparable;
    changed += entry.changed;
    if (entry.maxAbsDelta > maxAbsDelta) maxAbsDelta = entry.maxAbsDelta;
  }
  return { comparable, changed, maxAbsDelta };
}

function valueChannels({ descriptor, decoded }: CaptureSide): Map<string, Float64Array> {
  const channels = new Map<string, Float64Array>();
  for (const channel of descriptor.channels) {
    if (channel.role !== "y" && channel.role !== "value") continue;
    const found = decoded.channels.get(channel.name);
    if (found) channels.set(channel.name, found.values);
  }
  return channels;
}

function firstLength(channels: Map<string, Float64Array>): number {
  for (const values of channels.values()) return values.length;
  return 0;
}

function sameShape(a: number[] | null, b: number[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
