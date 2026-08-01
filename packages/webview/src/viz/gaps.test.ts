import { describe, expect, it } from "vitest";
import { type Grid, cellDistortion, fitted } from "./Heatmap";
import { type Series, toPlotData } from "./LinePlot";

function line(values: number[], hasGaps?: boolean): Series[] {
  return [
    {
      label: "y",
      values: Float64Array.from(values),
      x: Float64Array.from(values.map((_, i) => i)),
      hasGaps,
    },
  ];
}

describe("gaps reach uPlot as null", () => {
  /**
   * uPlot detects a gap with `yVal != null`, which NaN passes. It then computes
   * a pixel position from NaN and calls `lineTo(x, NaN)`, leaving the Path2D
   * invalid so the browser discards the rest of the stroke. One NaN anywhere
   * silently erased the whole line; markers still drew, which is why the data
   * appeared only when few enough points were shown to draw them.
   */
  it("replaces NaN with null", () => {
    const [, y] = toPlotData(line([1, Number.NaN, 3])) as unknown as [unknown, (number | null)[]];

    expect(y[1]).toBeNull();
    expect(Number.isNaN(y[1] as number)).toBe(false);
    expect(y[0]).toBe(1);
  });

  it("replaces Inf with null, which uPlot cannot plot either", () => {
    const [, y] = toPlotData(line([1, Number.POSITIVE_INFINITY, 3])) as unknown as [
      unknown,
      (number | null)[],
    ];
    expect(y[1]).toBeNull();
  });

  it("keeps the typed array when a series is clean", () => {
    // The common case, and the one worth keeping allocation-free.
    const data = toPlotData(line([1, 2, 3], false)) as unknown as unknown[];
    expect(data[1]).toBeInstanceOf(Float64Array);
  });

  it("scans when the runtime did not say whether there are gaps", () => {
    const data = toPlotData(line([1, Number.NaN, 3], undefined)) as unknown as unknown[];
    expect(Array.isArray(data[1])).toBe(true);
  });

  it("does not convert a clean series that merely might have had gaps", () => {
    const data = toPlotData(line([1, 2, 3], true)) as unknown as unknown[];
    expect(data[1]).toBeInstanceOf(Float64Array);
  });
});

describe("the heatmap fills its box", () => {
  const grid = (rows: number, cols: number): Grid =>
    ({ rows, cols, values: new Float64Array(rows * cols) }) as Grid;

  it("uses the full width for a roughly square matrix", () => {
    const size = fitted(grid(200, 300), 600, 360);
    expect(size.width).toBe("600px");
    expect(Number.parseFloat(size.height)).toBeLessThanOrEqual(360);
  });

  it("does not exceed the box for a tall matrix", () => {
    // 5000 rows of 2 columns: previously a page-long strip, then a two-pixel
    // thread. Now it fills the box.
    const size = fitted(grid(5000, 2), 600, 360);
    expect(size.width).toBe("600px");
    expect(size.height).toBe("360px");
  });

  it("says so when cells end up stretched", () => {
    expect(cellDistortion(grid(5000, 2), 600, 360)).toBeGreaterThan(2);
  });

  it("stays quiet when cells are close to square", () => {
    expect(cellDistortion(grid(200, 300), 600, 360)).toBeLessThan(2);
  });
});
