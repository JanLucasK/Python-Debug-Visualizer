/**
 * @vitest-environment happy-dom
 *
 * Does the plot actually get a y range?
 *
 * A uPlot whose y scale never ranges renders its axes, its legend and nothing
 * else -- which is exactly what an empty plot looks like, and gives no clue
 * whether the data, the decode or the configuration is at fault. Reading the
 * scale afterwards answers that directly, which reading the source did not.
 *
 * The canvas context and Path2D are stubbed: uPlot needs them to exist, and
 * nothing here depends on what it draws.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { type PlotSettings, type Series, createPlot } from "./LinePlot";

beforeAll(() => {
  const context = new Proxy(
    { measureText: () => ({ width: 10 }), canvas: {} } as Record<string, unknown>,
    {
      get: (target, key: string) => (key in target ? target[key] : () => undefined),
      set: () => true,
    },
  );

  // biome-ignore lint/suspicious/noExplicitAny: stubbing browser APIs for tests
  const global = globalThis as any;
  global.HTMLCanvasElement.prototype.getContext = () => context;
  global.Path2D = class {
    moveTo() {}
    lineTo() {}
    rect() {}
    arc() {}
    closePath() {}
    addPath() {}
  };
});

function container(): HTMLDivElement {
  const element = document.createElement("div");
  Object.defineProperty(element, "clientWidth", { value: 600, configurable: true });
  document.body.appendChild(element);
  return element;
}

function settings(overrides: Partial<PlotSettings> = {}): PlotSettings {
  return {
    mode: "line",
    timeAxis: false,
    logX: false,
    logY: false,
    onReady: () => undefined,
    onZoom: () => undefined,
    hasWindow: () => false,
    ...overrides,
  };
}

function series(x: number[], ...ys: number[][]): Series[] {
  return ys.map((values, index) => ({
    label: `s${index}`,
    values: Float64Array.from(values),
    x: Float64Array.from(x),
  }));
}

/**
 * uPlot commits its first draw asynchronously and ranges the scales as part of
 * it. Reading them straight after construction always finds null, which looks
 * identical to the failure under test.
 */
async function plot(data: Series[], overrides: Partial<PlotSettings> = {}) {
  const instance = createPlot(container(), data, 240, settings(overrides));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return instance;
}

describe("the y scale ranges over the data", () => {
  it("ranges a single series on positional x", async () => {
    const chart = await plot(series([0, 1, 2], [10, 20, 30]));

    expect(chart.scales.y?.min).toBeLessThanOrEqual(10);
    expect(chart.scales.y?.max).toBeGreaterThanOrEqual(30);
  });

  it("ranges two series on positional x", async () => {
    const chart = await plot(series([0, 1, 2], [10, 20, 30], [5, 6, 7]));

    expect(chart.scales.y?.min).toBeLessThanOrEqual(5);
    expect(chart.scales.y?.max).toBeGreaterThanOrEqual(30);
  });

  it("ranges two series on a millisecond time axis", async () => {
    // The reported failure: a DataFrame on a DatetimeIndex drew its date axis
    // and nothing else. Only the x values and the time flag differ from above.
    const stamps = [1_735_689_600_000, 1_735_776_000_000, 1_735_862_400_000];
    const chart = await plot(series(stamps, [100, 150, 200], [90, 140, 190]), {
      timeAxis: true,
    });

    expect(chart.scales.x?.min).toBeGreaterThan(1.7e12);
    expect(chart.scales.y?.min, "y never ranged").toBeLessThanOrEqual(90);
    expect(chart.scales.y?.max, "y never ranged").toBeGreaterThanOrEqual(200);
  });

  it("ranges with a logarithmic y axis", async () => {
    const chart = await plot(series([0, 1, 2], [1, 100, 10_000]), { logY: true });

    expect(chart.scales.y?.min).toBeGreaterThan(0);
    expect(chart.scales.y?.max).toBeGreaterThanOrEqual(10_000);
  });

  it("ranges in scatter mode", async () => {
    const chart = await plot(series([0, 1, 2], [10, 20, 30]), { mode: "scatter" });

    expect(chart.scales.y?.max).toBeGreaterThanOrEqual(30);
  });

  it("ranges a series containing gaps", async () => {
    const chart = await plot(series([0, 1, 2, 3], [10, Number.NaN, 30, 40]));

    expect(chart.scales.y?.max).toBeGreaterThanOrEqual(40);
  });
});
