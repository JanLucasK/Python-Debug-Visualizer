import type { Descriptor, NumericStats, VizKind } from "@python-debug-visualizer/protocol";
import { describe, expect, it } from "vitest";
import { COLORMAP_NAMES, DIVERGING_COLORMAPS, lookupTable, sampleColormap } from "./colormaps";
import { availableViz, resolveViz } from "./index";

function stats(overrides: Partial<NumericStats> = {}): NumericStats {
  return { count: 10, min: 0, max: 1, mean: 0.5, std: 0.2, nanCount: 0, infCount: 0, ...overrides };
}

function descriptor(overrides: Partial<Descriptor> = {}): Descriptor {
  return {
    kind: "ndarray",
    pythonType: "numpy.ndarray",
    preview: "array([...])",
    shape: [100],
    dtype: "float64",
    nbytes: 800,
    stats: stats(),
    index: null,
    columns: null,
    channels: [],
    decimation: null,
    window: null,
    truncated: false,
    suggestedViz: ["line"],
    ...overrides,
  };
}

const kinds = (list: { kind: VizKind }[]) => list.map((entry) => entry.kind);

describe("visualization availability", () => {
  it("offers line, scatter and histogram for a 1-D numeric array", () => {
    const offered = kinds(availableViz(descriptor()));
    expect(offered).toEqual(expect.arrayContaining(["line", "scatter", "histogram"]));
    expect(offered).not.toContain("heatmap");
  });

  it("offers heatmap only for 2-D values", () => {
    expect(kinds(availableViz(descriptor({ shape: [8, 8] })))).toContain("heatmap");
    expect(kinds(availableViz(descriptor({ shape: [8] })))).not.toContain("heatmap");
    expect(kinds(availableViz(descriptor({ shape: [2, 3, 4] })))).not.toContain("heatmap");
  });

  it("always offers something, even for a value it cannot chart", () => {
    const opaque = descriptor({ kind: "object", shape: null, stats: null, suggestedViz: ["tree"] });
    expect(kinds(availableViz(opaque))).toEqual(["tree"]);
    expect(resolveViz(opaque, "auto")?.kind).toBe("tree");
  });

  it("keeps every option available after switching to a histogram", () => {
    // The regression this guards: a histogram capture carries bin channels
    // instead of points. Deciding availability from the channels present would
    // hide line and scatter exactly when the user wants to switch back, leaving
    // them stranded in the histogram.
    const binned = descriptor({
      channels: [
        {
          name: "binEdge",
          role: "binEdge",
          dtype: "f64",
          length: 5,
          byteOffset: 0,
          byteLength: 40,
          stats: null,
        },
        {
          name: "binCount",
          role: "binCount",
          dtype: "i64",
          length: 4,
          byteOffset: 40,
          byteLength: 32,
          stats: null,
        },
      ],
      suggestedViz: ["histogram"],
    });

    expect(kinds(availableViz(binned))).toEqual(expect.arrayContaining(["line", "scatter"]));
    expect(resolveViz(binned, "line")?.kind).toBe("line");
  });
});

describe("resolveViz", () => {
  it("follows the adapter's suggestion when the user has not chosen", () => {
    expect(resolveViz(descriptor({ suggestedViz: ["scatter", "line"] }), "auto")?.kind).toBe(
      "scatter",
    );
  });

  it("honours an explicit choice over the suggestion", () => {
    expect(resolveViz(descriptor({ suggestedViz: ["line"] }), "histogram")?.kind).toBe("histogram");
  });

  it("falls back when the chosen kind does not suit the value", () => {
    // Heatmap on a 1-D array is impossible, so the suggestion wins rather than
    // the pane rendering nothing.
    expect(resolveViz(descriptor({ shape: [50] }), "heatmap")?.kind).toBe("line");
  });

  it("still resolves when the suggestion is unavailable", () => {
    const odd = descriptor({ shape: [4, 4], suggestedViz: ["line"] });
    expect(resolveViz(odd, "auto")).toBeDefined();
  });
});

describe("colormaps", () => {
  it("builds a full 256-entry table for every map", () => {
    for (const name of COLORMAP_NAMES) {
      expect(lookupTable(name).length, name).toBe(256 * 3);
    }
  });

  it("returns the same table object on repeated lookups", () => {
    expect(lookupTable("viridis")).toBe(lookupTable("viridis"));
  });

  it("keeps the endpoints exactly as specified", () => {
    const table = lookupTable("gray");
    expect([table[0], table[1], table[2]]).toEqual([0, 0, 0]);
    expect([table[765], table[766], table[767]]).toEqual([255, 255, 255]);
  });

  it("moves through lightness monotonically for sequential maps", () => {
    // The property that separates a usable sequential ramp from a rainbow: a
    // reader can order two colours without consulting a legend. Non-monotonic
    // maps like jet fail this, which is why the same value can look like a peak
    // in one part of the range and a trough in another.
    //
    // The *direction* deliberately varies. viridis runs dark-to-light and the
    // single-hue blues ramp runs light-to-dark; both are the convention in
    // their own world, and the colorbar states which way round it is. Pinning
    // them to a common direction would mean redrawing one of them wrong.
    for (const name of COLORMAP_NAMES) {
      if (DIVERGING_COLORMAPS.has(name)) continue;
      const table = lookupTable(name);
      const luminance = (i: number) =>
        0.2126 * (table[i * 3] as number) +
        0.7152 * (table[i * 3 + 1] as number) +
        0.0722 * (table[i * 3 + 2] as number);

      const ascending = luminance(255) > luminance(0);
      for (let i = 8; i < 256; i += 8) {
        const [before, after] = [luminance(i - 8), luminance(i)];
        if (ascending) {
          expect(after, `${name} at ${i}`).toBeGreaterThan(before);
        } else {
          expect(after, `${name} at ${i}`).toBeLessThan(before);
        }
      }

      // A ramp that barely changes lightness is unreadable regardless of
      // direction, so the span has to be substantial.
      expect(Math.abs(luminance(255) - luminance(0)), name).toBeGreaterThan(100);
    }
  });

  it("gives the diverging map a light, near-neutral midpoint", () => {
    const table = lookupTable("coolwarm");
    const mid = 128 * 3;
    const [r, g, b] = [table[mid] as number, table[mid + 1] as number, table[mid + 2] as number];
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(30);
    expect(Math.min(r, g, b)).toBeGreaterThan(150);
  });

  it("clamps samples taken outside the unit interval", () => {
    expect(sampleColormap("viridis", -5)).toBe(sampleColormap("viridis", 0));
    expect(sampleColormap("viridis", 5)).toBe(sampleColormap("viridis", 1));
  });
});

describe("frames and matrices are told apart", () => {
  /**
   * The bug this pins down: a DataFrame and a 2-D array both report
   * [rows, columns]. Deciding from shape alone offered the frame a heatmap and
   * withheld the line plot, so plotting a DataFrame -- the whole reason the
   * pandas adapter exists -- silently produced a table instead.
   */
  const frame = () =>
    descriptor({
      kind: "frame",
      shape: [400, 4],
      dtype: null,
      suggestedViz: ["line", "grid"],
    });

  // Matching what the NumPy adapter actually sends for a 2-D array.
  const matrix = () =>
    descriptor({
      kind: "ndarray",
      shape: [200, 300],
      suggestedViz: ["heatmap", "grid", "histogram"],
    });

  it("offers a line plot for a DataFrame", () => {
    expect(kinds(availableViz(frame()))).toContain("line");
    expect(resolveViz(frame(), "auto")?.kind).toBe("line");
  });

  it("offers a heatmap for a DataFrame without defaulting to it", () => {
    // Availability is the user's call: a correlation matrix is a fine heatmap
    // whichever container it arrived in. The *suggestion* is ours, and unrelated
    // columns on one colour scale would compare prices against volumes.
    expect(kinds(availableViz(frame()))).toContain("heatmap");
    expect(resolveViz(frame(), "auto")?.kind).toBe("line");
    expect(resolveViz(frame(), "heatmap")?.kind).toBe("heatmap");
  });

  it("offers a heatmap for a raw matrix", () => {
    expect(kinds(availableViz(matrix()))).toContain("heatmap");
    expect(resolveViz(matrix(), "auto")?.kind).toBe("heatmap");
  });

  it("also offers lines for a narrow matrix", () => {
    // np.column_stack([a, b]) is a natural way to ask for two lines.
    expect(kinds(availableViz(descriptor({ kind: "ndarray", shape: [500, 2] })))).toContain("line");
  });

  it("does not offer lines for a wide matrix", () => {
    expect(kinds(availableViz(matrix()))).not.toContain("line");
  });

  it("offers a line plot for a dict of arrays", () => {
    const mapping = descriptor({ kind: "mapping", shape: [100, 2], suggestedViz: ["line"] });
    expect(resolveViz(mapping, "auto")?.kind).toBe("line");
  });

  it("offers a line plot for a Series and a plain list", () => {
    for (const kind of ["series", "sequence", "index"] as const) {
      expect(kinds(availableViz(descriptor({ kind }))), kind).toContain("line");
    }
  });
});
