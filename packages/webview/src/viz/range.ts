/**
 * Deciding whether a view change is worth re-capturing for.
 *
 * Zoom is a loop: the user drags, the runtime re-captures inside the range, and
 * the new data arrives. After a refetch the data *is* the window, so the plot's
 * natural full extent equals the range that was asked for -- and asking for it
 * again would loop forever.
 *
 * An earlier version watched uPlot's `setScale`, which cannot distinguish a
 * gesture from the plot maintaining itself: uPlot fires it while constructing,
 * and once more *after* the `ready` hook, so no flag cleared in `ready` can
 * separate them. That read as "covers everything, therefore zoomed out" and
 * requested the whole value back, undoing every zoom a moment after it landed.
 *
 * The trigger is now `setSelect` with a non-empty selection, which only a drag
 * produces. This module remains the guard against re-requesting a window that
 * is already displayed.
 */

export type Range = [number, number];

/**
 * Whether two ranges describe the same view.
 *
 * Compared with a tolerance rather than exactly: a scale that has been through
 * a rescale comes back a hair different from the numbers that produced it, and
 * an exact comparison lets the feedback loop through on the last decimal.
 */
export function sameRange(a: Range | null, b: Range | null): boolean {
  if (a === null || b === null) return a === b;

  const span = Math.max(Math.abs(b[1] - b[0]), Math.abs(a[1] - a[0]));
  if (span === 0) return a[0] === b[0] && a[1] === b[1];

  const tolerance = span * 1e-6;
  return Math.abs(a[0] - b[0]) < tolerance && Math.abs(a[1] - b[1]) < tolerance;
}

/**
 * The range to request, or undefined when nothing should be requested.
 *
 * `next` is what the plot now shows — null meaning it covers everything it
 * holds. `applied` is the window the current capture was taken for.
 */
export function zoomRequest(
  next: Range | null,
  applied: Range | null,
  duringBuild: boolean,
): Range | null | undefined {
  // Building and re-feeding data both move the scale without anyone asking.
  if (duringBuild) return undefined;
  if (sameRange(next, applied)) return undefined;
  return next;
}
