import type { ResolvedCapture } from "@python-debug-visualizer/protocol";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HISTORY_DEPTH,
  forget,
  normalizeDepth,
  pushCapture,
  shiftOffset,
  viewOf,
} from "./history";

function capture(sequence: number): ResolvedCapture {
  return {
    expression: "x",
    descriptor: {
      kind: "ndarray",
      pythonType: "numpy.ndarray",
      preview: "",
      shape: [1],
      dtype: "float64",
      nbytes: 8,
      stats: null,
      index: null,
      columns: null,
      channels: [],
      decimation: null,
      window: null,
      truncated: false,
      suggestedViz: ["line"],
    },
    bytes: null,
    warnings: [],
    elapsedMs: 1,
    capturedAt: 1_000 + sequence,
    sequence,
  };
}

describe("normalizeDepth", () => {
  it("accepts a sensible number", () => {
    expect(normalizeDepth(20)).toBe(20);
  });

  it("falls back when the value is missing or not a number", () => {
    // The actual failure this guards: an older extension build sent no depth at
    // all, `Math.max(1, undefined)` produced NaN, `slice(0, NaN)` produced an
    // empty array, and every pane showed "waiting for the debugger" forever
    // while captures arrived normally.
    for (const bad of [undefined, null, Number.NaN, "abc", {}]) {
      expect(normalizeDepth(bad), String(bad)).toBe(DEFAULT_HISTORY_DEPTH);
    }
  });

  it("never returns less than one", () => {
    expect(normalizeDepth(0)).toBe(1);
    expect(normalizeDepth(-5)).toBe(1);
  });

  it("caps absurd values", () => {
    expect(normalizeDepth(1e9)).toBe(1000);
  });
});

describe("pushCapture", () => {
  it("puts the newest capture first", () => {
    let history = {};
    history = pushCapture(history, "p", capture(1), 5);
    history = pushCapture(history, "p", capture(2), 5);

    expect((history as Record<string, ResolvedCapture[]>).p?.map((c) => c.sequence)).toEqual([
      2, 1,
    ]);
  });

  it("keeps at most `depth` captures", () => {
    let history = {};
    for (let i = 1; i <= 10; i++) history = pushCapture(history, "p", capture(i), 3);

    expect((history as Record<string, ResolvedCapture[]>).p?.map((c) => c.sequence)).toEqual([
      10, 9, 8,
    ]);
  });

  it("keeps the newest capture whatever the depth says", () => {
    // The structural guarantee: history is a convenience, the current value is
    // the whole point. No setting may cause it to vanish.
    for (const depth of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const history = pushCapture({}, "p", capture(1), depth as number);
      expect(history.p?.length, String(depth)).toBeGreaterThanOrEqual(1);
    }
  });

  it("keeps panes independent", () => {
    let history = pushCapture({}, "a", capture(1), 5);
    history = pushCapture(history, "b", capture(2), 5);

    expect(history.a?.length).toBe(1);
    expect(history.b?.length).toBe(1);
  });
});

describe("shiftOffset", () => {
  it("leaves a pane that is following the newest capture alone", () => {
    expect(shiftOffset({ p: 0 }, "p", 20)).toEqual({ p: 0 });
    expect(shiftOffset({}, "p", 20)).toEqual({});
  });

  it("moves a scrubbed-back pane so it stays on the same capture", () => {
    expect(shiftOffset({ p: 3 }, "p", 20).p).toBe(4);
  });

  it("stops at the oldest capture rather than running off the end", () => {
    expect(shiftOffset({ p: 4 }, "p", 5).p).toBe(4);
  });
});

describe("viewOf", () => {
  it("returns nothing for a pane with no captures", () => {
    expect(viewOf({}, {}, "p").capture).toBeUndefined();
    expect(viewOf({}, {}, "p").offset).toBe(0);
  });

  it("returns the newest capture by default", () => {
    const history = pushCapture(pushCapture({}, "p", capture(1), 5), "p", capture(2), 5);
    expect(viewOf(history, {}, "p").capture?.sequence).toBe(2);
  });

  it("clamps an offset that outran a shortened history", () => {
    const history = pushCapture({}, "p", capture(1), 5);
    const view = viewOf(history, { p: 9 }, "p");

    expect(view.offset).toBe(0);
    expect(view.capture?.sequence).toBe(1);
  });
});

describe("forget", () => {
  it("drops the named panes and leaves the rest", () => {
    expect(forget({ a: 1, b: 2, c: 3 }, ["a", "c"])).toEqual({ b: 2 });
  });

  it("returns the same object when there is nothing to drop", () => {
    const record = { a: 1 };
    expect(forget(record, [])).toBe(record);
  });
});
