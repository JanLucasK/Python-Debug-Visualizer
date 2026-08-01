import type { ResolvedCapture } from "@python-debug-visualizer/protocol";

/**
 * Per-pane capture history.
 *
 * Pure functions rather than logic inlined into the component, so the rules can
 * be tested without a DOM — the last time this behaviour lived inside a state
 * setter, a bad depth silently emptied every pane and the symptom was a
 * permanent "waiting for the debugger" message with no clue as to why.
 */

export const DEFAULT_HISTORY_DEPTH = 20;

export type History = Record<string, ResolvedCapture[]>;
export type Offsets = Record<string, number>;

/**
 * A usable depth, whatever arrived.
 *
 * Settings cross a process boundary and can be missing, non-numeric or absurd;
 * `Math.max(1, undefined)` is NaN, and slicing to NaN yields an empty array,
 * which is how a single bad value can hide every capture in the UI.
 */
export function normalizeDepth(value: unknown): number {
  // Only an actual finite number is trusted. Coercing instead would quietly
  // turn `null` into 0 and `""` into 0 -- both meaning "not provided", both
  // ending up as "keep nothing".
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_HISTORY_DEPTH;
  return Math.max(1, Math.min(Math.floor(value), 1000));
}

/**
 * Add a capture to a pane's history, newest first.
 *
 * The newest capture is retained unconditionally. History is a convenience; the
 * current value is the entire point of the tool, so no configuration may cause
 * it to be dropped.
 */
export function pushCapture(
  history: History,
  paneId: string,
  capture: ResolvedCapture,
  depth: number,
): History {
  const limit = Math.max(1, normalizeDepth(depth));
  const kept = [capture, ...(history[paneId] ?? [])].slice(0, limit);
  return { ...history, [paneId]: kept };
}

/**
 * Move a pane's view along with an incoming capture.
 *
 * Someone scrubbed back is holding a step still on purpose, usually to compare
 * it against what happens next. Snapping them to the newest capture every time
 * the debugger stops would take that away at exactly the wrong moment, so the
 * offset shifts to keep them on the capture they were looking at.
 */
export function shiftOffset(offsets: Offsets, paneId: string, depth: number): Offsets {
  const offset = offsets[paneId] ?? 0;
  if (offset === 0) return offsets; // already following the newest
  return { ...offsets, [paneId]: Math.min(offset + 1, Math.max(1, normalizeDepth(depth)) - 1) };
}

/** The capture a pane should display, and a safe offset for it. */
export function viewOf(
  history: History,
  offsets: Offsets,
  paneId: string,
): { capture: ResolvedCapture | undefined; offset: number; kept: ResolvedCapture[] } {
  const kept = history[paneId] ?? [];
  const offset = Math.max(0, Math.min(offsets[paneId] ?? 0, kept.length - 1));
  return { capture: kept[offset], offset, kept };
}

export function forget<T>(record: Record<string, T>, paneIds: string[]): Record<string, T> {
  if (paneIds.length === 0) return record;
  const next = { ...record };
  for (const id of paneIds) delete next[id];
  return next;
}
