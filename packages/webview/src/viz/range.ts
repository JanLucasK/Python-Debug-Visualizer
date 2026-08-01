/**
 * Deciding whether a scale change is worth acting on.
 *
 * Zoom is a loop: the user drags, the runtime re-captures inside the range, and
 * the new data arrives. uPlot reports a scale change at every step of that --
 * while building itself, after new data, and when the user drags -- and only
 * the last one is a request.
 *
 * The trap is that after a refetch the data *is* the window, so the plot's
 * natural full-extent scale looks identical to a user zooming to the window
 * they are already in. Forwarding it asks for the same range again; reading it
 * as "covers everything, so zoomed out" asks for the whole value. Either way
 * the view snaps back and the zoom undoes itself, which is what it did.
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
