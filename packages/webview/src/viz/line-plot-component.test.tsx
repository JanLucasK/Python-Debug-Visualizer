/**
 * @vitest-environment happy-dom
 *
 * What actually reaches uPlot when the component renders.
 *
 * The other tests call `collectSeries` and `createPlot` directly, which skips
 * everything Preact does in between: the memos, the layout effect, the ref the
 * data is read through, and the second `setData` that follows. A DataFrame
 * plotted as lines came out empty in the real webview while every one of those
 * direct tests passed, so the gap is exactly there.
 *
 * uPlot is replaced by a recorder, so this asserts on the arguments rather than
 * on pixels.
 */

import { render } from "preact";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Recorded {
  options: Record<string, unknown>;
  data: ArrayLike<ArrayLike<number>>;
}

const constructed: Recorded[] = [];
const dataUpdates: ArrayLike<ArrayLike<number>>[] = [];

vi.mock("uplot", () => {
  class FakePlot {
    scales = { x: { min: 0, max: 1 }, y: { min: 0, max: 1 } };
    select = { left: 0, width: 0 };

    constructor(options: Record<string, unknown>, data: ArrayLike<ArrayLike<number>>) {
      constructed.push({ options, data });
    }
    setData(data: ArrayLike<ArrayLike<number>>) {
      dataUpdates.push(data);
    }
    setSize() {}
    destroy() {}
    posToVal(position: number) {
      return position;
    }
  }
  return { default: FakePlot };
});

vi.mock("uplot/dist/uPlot.min.css", () => ({}));

const { LinePlot } = await import("./LinePlot");
const { decodeChannels } = await import("../decode");
const { frameCapture } = await import("./test-captures");

beforeEach(() => {
  constructed.length = 0;
  dataUpdates.length = 0;
});

function renderPlot(capture: ReturnType<typeof frameCapture>) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  render(
    <LinePlot
      descriptor={capture.descriptor}
      decoded={decodeChannels(capture.descriptor, capture.bytes)}
    />,
    host,
  );
  return host;
}

describe("what the component hands to uPlot", () => {
  it("constructs the plot at all", () => {
    renderPlot(frameCapture());
    expect(constructed.length, "no plot was constructed").toBe(1);
  });

  it("passes three data arrays for a two-column frame", () => {
    renderPlot(frameCapture());
    const { data } = constructed[0] as Recorded;

    expect(data.length, "x plus two series").toBe(3);
    expect((data[1] as ArrayLike<number>).length).toBe(400);
    expect((data[2] as ArrayLike<number>).length).toBe(400);
  });

  it("passes finite y values, which an empty plot would lack", () => {
    renderPlot(frameCapture());
    const { data } = constructed[0] as Recorded;

    for (const index of [1, 2]) {
      const values = Array.from(data[index] as ArrayLike<number>);
      expect(values.filter(Number.isFinite).length, `series ${index}`).toBe(400);
    }
  });

  it("declares one series entry per column plus the x entry", () => {
    renderPlot(frameCapture());
    const series = (constructed[0] as Recorded).options.series as { label: string }[];

    expect(series.map((s) => s.label)).toEqual(["time", "close", "sma20"]);
  });

  it("keeps the data intact through the follow-up setData", () => {
    renderPlot(frameCapture());
    for (const data of dataUpdates) {
      expect(data.length).toBe(3);
      expect((data[1] as ArrayLike<number>).length).toBe(400);
    }
  });
});
