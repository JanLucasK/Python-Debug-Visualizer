import type { Channel, Descriptor } from "@python-debug-visualizer/protocol";
import { describe, expect, it } from "vitest";
import { decodeChannels } from "./decode";
import { type CaptureSide, diffCaptures, totals } from "./diff";

/** Builds a capture the way the runtime would: values, optional x positions. */
function side(values: Record<string, number[]>, positions?: number[]): CaptureSide {
  const channels: Channel[] = [];
  const buffers: ArrayBuffer[] = [];
  let offset = 0;

  if (positions) {
    const buffer = new BigInt64Array(positions.map((p) => BigInt(p))).buffer;
    channels.push({
      name: "x",
      role: "x",
      dtype: "i64",
      length: positions.length,
      byteOffset: offset,
      byteLength: buffer.byteLength,
      stats: null,
    });
    buffers.push(buffer);
    offset += buffer.byteLength;
  }

  for (const [name, numbers] of Object.entries(values)) {
    const buffer = new Float64Array(numbers).buffer;
    channels.push({
      name,
      role: "y",
      dtype: "f64",
      length: numbers.length,
      byteOffset: offset,
      byteLength: buffer.byteLength,
      stats: null,
    });
    buffers.push(buffer);
    offset += buffer.byteLength;
  }

  const bytes = new Uint8Array(offset);
  let cursor = 0;
  for (const buffer of buffers) {
    bytes.set(new Uint8Array(buffer), cursor);
    cursor += buffer.byteLength;
  }

  const first = Object.values(values)[0] ?? [];
  const descriptor: Descriptor = {
    kind: "ndarray",
    pythonType: "numpy.ndarray",
    preview: "",
    shape: [first.length],
    dtype: "float64",
    nbytes: null,
    stats: null,
    index: null,
    columns: null,
    channels,
    decimation: null,
    truncated: false,
    suggestedViz: ["line"],
  };

  return { descriptor, decoded: decodeChannels(descriptor, bytes) };
}

describe("diffCaptures", () => {
  it("reports element-wise change", () => {
    const summary = diffCaptures(side({ y: [1, 2, 3] }), side({ y: [1, 5, 3] }));
    const [series] = summary.series;

    expect(series?.comparable).toBe(3);
    expect(series?.changed).toBe(1);
    expect(series?.maxAbsDelta).toBe(3);
    expect(Array.from(series?.delta ?? [])).toEqual([0, -3, 0]);
  });

  it("reports nothing changed when nothing changed", () => {
    const summary = diffCaptures(side({ y: [1, 2, 3] }), side({ y: [1, 2, 3] }));
    expect(totals(summary).changed).toBe(0);
  });

  it("aligns on x positions rather than on array index", () => {
    // The trap this whole module exists for. Two captures of the same array can
    // be decimated to different points, so index 1 of one and index 1 of the
    // other are different elements. Subtracting them positionally invents a
    // delta that looks entirely plausible.
    const current = side({ y: [10, 30] }, [0, 20]);
    const reference = side({ y: [10, 25, 30] }, [0, 10, 20]);

    const [series] = diffCaptures(current, reference).series;

    expect(series?.comparable).toBe(2);
    expect(Array.from(series?.delta ?? [])).toEqual([0, 0]);
    expect(series?.changed).toBe(0);
  });

  it("would have reported a false change without alignment", () => {
    // Same data as above, checked from the other direction: positional
    // subtraction would compare 30 against 25 and claim a delta of 5.
    const current = side({ y: [10, 30] }, [0, 20]);
    const reference = side({ y: [10, 25, 30] }, [0, 10, 20]);

    const naive = Math.abs(30 - 25);
    expect(naive).toBe(5);
    expect(totals(diffCaptures(current, reference)).maxAbsDelta).toBe(0);
  });

  it("counts points that had no counterpart instead of comparing them to nothing", () => {
    const current = side({ y: [1, 2, 3] }, [0, 1, 2]);
    const reference = side({ y: [1] }, [0]);

    const summary = diffCaptures(current, reference);
    expect(summary.unmatched).toBe(2);
    expect(summary.series[0]?.comparable).toBe(1);
  });

  it("propagates NaN rather than calling a gap unchanged", () => {
    const summary = diffCaptures(side({ y: [1, Number.NaN, 3] }), side({ y: [1, 2, 3] }));
    const delta = summary.series[0]?.delta;

    expect(Number.isNaN(delta?.[1] as number)).toBe(true);
    // A gap is not a change of zero, and must not be counted as either.
    expect(summary.series[0]?.changed).toBe(0);
  });

  it("notices a shape change", () => {
    const summary = diffCaptures(side({ y: [1, 2, 3] }), side({ y: [1, 2] }));
    expect(summary.shapeChanged).toBe(true);
    expect(summary.previousShape).toEqual([2]);
  });

  it("diffs several named series independently", () => {
    const summary = diffCaptures(
      side({ a: [1, 2], b: [10, 20] }),
      side({ a: [1, 2], b: [10, 25] }),
    );

    const byName = Object.fromEntries(summary.series.map((entry) => [entry.name, entry]));
    expect(byName.a?.changed).toBe(0);
    expect(byName.b?.changed).toBe(1);
    expect(totals(summary).maxAbsDelta).toBe(5);
  });

  it("ignores series that exist on only one side", () => {
    const summary = diffCaptures(side({ a: [1], b: [2] }), side({ a: [1] }));
    expect(summary.series.map((entry) => entry.name)).toEqual(["a"]);
  });

  it("says so when the two share nothing comparable", () => {
    const summary = diffCaptures(side({ a: [1] }), side({ b: [1] }));
    expect(summary.incomparable).toBeTruthy();
  });

  it("computes mean absolute delta over changed points only", () => {
    const summary = diffCaptures(side({ y: [1, 2, 3, 4] }), side({ y: [1, 2, 1, 0] }));
    // Deltas 0, 0, 2, 4 -- the mean of the two that moved.
    expect(summary.series[0]?.meanAbsDelta).toBe(3);
  });
});
