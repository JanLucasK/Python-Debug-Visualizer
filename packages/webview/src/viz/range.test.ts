import { describe, expect, it } from "vitest";
import { type Range, sameRange, zoomRequest } from "./range";

describe("sameRange", () => {
  it("matches identical ranges", () => {
    expect(sameRange([0, 100], [0, 100])).toBe(true);
  });

  it("separates different ranges", () => {
    expect(sameRange([0, 100], [0, 50])).toBe(false);
    expect(sameRange([10, 100], [0, 100])).toBe(false);
  });

  it("treats null as its own value", () => {
    expect(sameRange(null, null)).toBe(true);
    expect(sameRange(null, [0, 1])).toBe(false);
    expect(sameRange([0, 1], null)).toBe(false);
  });

  it("tolerates the drift a rescale introduces", () => {
    // An exact comparison lets the feedback loop through on the last decimal,
    // which is how the zoom used to undo itself.
    expect(sameRange([0, 1_000_000], [0.0000001, 999_999.9999999])).toBe(true);
  });

  it("does not treat a genuinely narrower range as the same", () => {
    expect(sameRange([0, 999_000], [0, 1_000_000])).toBe(false);
  });

  it("handles a degenerate range", () => {
    expect(sameRange([5, 5], [5, 5])).toBe(true);
    expect(sameRange([5, 5], [5, 6])).toBe(false);
  });
});

describe("zoomRequest", () => {
  const window: Range = [500, 1500];

  it("ignores everything while the plot is building", () => {
    // uPlot moves the view as it constructs itself and again when it is fed new
    // data. Neither is a request.
    expect(zoomRequest([0, 10], null, true)).toBeUndefined();
    expect(zoomRequest(null, window, true)).toBeUndefined();
  });

  it("forwards a drag into a narrower range", () => {
    expect(zoomRequest([100, 200], null, false)).toEqual([100, 200]);
  });

  it("forwards a further zoom inside an existing window", () => {
    expect(zoomRequest([600, 700], window, false)).toEqual([600, 700]);
  });

  it("ignores a request for the window already displayed", () => {
    // The regression this exists for. After capturing for [500, 1500] the data
    // *is* that window, so the plot's natural extent equals it -- and asking
    // for it again would loop forever.
    expect(zoomRequest(window, window, false)).toBeUndefined();
  });

  it("ignores a full-extent scale when nothing was zoomed", () => {
    expect(zoomRequest(null, null, false)).toBeUndefined();
  });

  it("forwards zooming out of a window", () => {
    // Double-click on a windowed capture is an explicit request for the whole
    // value: uPlot's own reset would only return to the window it holds.
    expect(zoomRequest(null, window, false)).toBeNull();
  });
});
