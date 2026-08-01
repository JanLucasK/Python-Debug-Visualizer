import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";
import type { Descriptor } from "@python-debug-visualizer/protocol";
import { describe, expect, it } from "vitest";
import { decodeChannels } from "../decode";
import { collectTable } from "./DataGrid";
import { collectSeries, toPlotData } from "./LinePlot";
import { availableViz, resolveViz } from "./index";

const runtimeSrc = resolve(__dirname, "..", "..", "..", "runtime", "src");
const venvPython = resolve(__dirname, "..", "..", "..", "..", ".venv", "bin", "python");
const python = existsSync(venvPython) ? venvPython : "python3";

/** A real capture from the real runtime, decoded the way the extension does. */
function capture(expression: string): { descriptor: Descriptor; bytes: Uint8Array } {
  const output = execFileSync(
    python,
    [
      "-c",
      `
import sys, numpy as np, pandas as pd
import _pdv
print(_pdv.capture(${expression}))
`,
    ],
    { env: { ...process.env, PYTHONPATH: runtimeSrc }, encoding: "utf8" },
  ).trim();

  const body = inflateSync(Buffer.from(output, "base64"));
  const jsonLength = body.readUInt32LE(0);
  const document = JSON.parse(body.subarray(4, 4 + jsonLength).toString("utf8"));
  const payload = body.subarray(4 + jsonLength);

  const bytes = new Uint8Array(payload.length);
  bytes.set(payload);
  return { descriptor: document.descriptor, bytes };
}

const FRAME = `pd.DataFrame(
  {"close": np.linspace(100.0, 200.0, 400), "sma20": np.linspace(90.0, 190.0, 400)},
  index=pd.date_range("2025-01-01", periods=400, freq="B"),
)`;

describe("a DataFrame reaches the plot intact", () => {
  it("decodes both columns", () => {
    const { descriptor, bytes } = capture(FRAME);
    const decoded = decodeChannels(descriptor, bytes);

    expect([...decoded.channels.keys()].sort()).toEqual(["close", "sma20", "x"]);
    expect(decoded.channels.get("close")?.values.length).toBe(400);
  });

  it("collects two plottable series", () => {
    const { descriptor, bytes } = capture(FRAME);
    const series = collectSeries(descriptor, decodeChannels(descriptor, bytes));

    expect(series.map((s) => s.label)).toEqual(["close", "sma20"]);
    expect(series[0]?.values.length).toBe(400);
  });

  it("produces finite y values, which is what an empty plot would lack", () => {
    const { descriptor, bytes } = capture(FRAME);
    const series = collectSeries(descriptor, decodeChannels(descriptor, bytes));

    for (const entry of series) {
      const finite = Array.from(entry.values).filter(Number.isFinite);
      expect(finite.length, entry.label).toBe(400);
      expect(Math.min(...finite), entry.label).toBeGreaterThan(50);
    }
  });

  it("lays the series on one shared millisecond axis", () => {
    const { descriptor, bytes } = capture(FRAME);
    const data = toPlotData(
      collectSeries(descriptor, decodeChannels(descriptor, bytes)),
    ) as unknown as ArrayLike<ArrayLike<number>>;

    expect(data.length).toBe(3);
    const x = Array.from(data[0] as ArrayLike<number>);
    expect(x.length).toBe(400);
    // 2025-01-01 in milliseconds, not seconds and not nanoseconds.
    expect(x[0]).toBeGreaterThan(1.7e12);
    expect(x[0]).toBeLessThan(1.8e12);
    expect(x.every((value, i) => i === 0 || value > (x[i - 1] as number))).toBe(true);
  });
});

describe("a DataFrame is not mistaken for a matrix", () => {
  it("tabulates its columns by name", () => {
    // The reported bug: the table branch keyed on shape alone. A DataFrame also
    // reports [rows, columns], so it looked for a channel called "value", found
    // none, and claimed there was nothing to tabulate -- for every DataFrame.
    const { descriptor, bytes } = capture(FRAME);
    const table = collectTable(descriptor, decodeChannels(descriptor, bytes));

    expect(table, "no table was produced for a DataFrame").toBeDefined();
    expect(table?.columns.map((c) => c.label)).toEqual(["close", "sma20"]);
    expect(table?.rows).toBe(400);
  });

  it("labels its rows with dates rather than epoch milliseconds", () => {
    const { descriptor, bytes } = capture(FRAME);
    const table = collectTable(descriptor, decodeChannels(descriptor, bytes));

    expect(table?.rowLabel(0)).toMatch(/^2025-01-01/);
  });

  it("still reads a raw matrix by stride", () => {
    const { descriptor, bytes } = capture("np.arange(12.0).reshape(4, 3)");
    const table = collectTable(descriptor, decodeChannels(descriptor, bytes));

    expect(table?.columns.map((c) => c.label)).toEqual(["0", "1", "2"]);
    expect(table?.valueAt(1, table.columns[1] as never)).toBe(4);
  });
});

describe("a narrow matrix defaults to lines", () => {
  it("suggests lines for column_stack, not a heatmap", () => {
    // Two columns of five thousand rows drawn as a heatmap is a two-pixel-wide
    // smear, which is what was reported.
    const { descriptor } = capture("np.column_stack([np.arange(5000.0), np.arange(5000.0) * 2])");
    expect(descriptor.suggestedViz[0]).toBe("line");
  });

  it("still suggests a heatmap for a genuinely wide matrix", () => {
    const { descriptor } = capture("np.zeros((200, 300))");
    expect(descriptor.suggestedViz[0]).toBe("heatmap");
  });
});

describe("what the pane offers for a DataFrame", () => {
  it("includes a heatmap", () => {
    // A frame is [rows, columns] like any matrix, and a correlation matrix is a
    // good heatmap whichever container it arrived in. Withholding it confused a
    // default with a restriction.
    const { descriptor } = capture(FRAME);
    expect(availableViz(descriptor).map((d) => d.kind)).toContain("heatmap");
  });

  it("still defaults to lines", () => {
    // Unrelated columns on one colour scale would compare prices against
    // volumes, so the suggestion stays opinionated even though the option is
    // available.
    const { descriptor } = capture(FRAME);
    expect(resolveViz(descriptor, "auto")?.kind).toBe("line");
    expect(resolveViz(descriptor, "heatmap")?.kind).toBe("heatmap");
  });
});
