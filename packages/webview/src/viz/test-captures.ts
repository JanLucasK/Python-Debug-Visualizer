import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";
import type { Descriptor } from "@python-debug-visualizer/protocol";

/**
 * Real captures from the real runtime, for tests that need genuine bytes.
 *
 * Hand-built fixtures would encode what I believe the runtime emits, and the
 * whole point of these tests is that the belief was wrong somewhere.
 */

const runtimeSrc = resolve(__dirname, "..", "..", "..", "runtime", "src");
const venvPython = resolve(__dirname, "..", "..", "..", "..", ".venv", "bin", "python");
const python = existsSync(venvPython) ? venvPython : "python3";

export interface TestCapture {
  descriptor: Descriptor;
  bytes: Uint8Array;
}

export function captureExpression(expression: string): TestCapture {
  const output = execFileSync(
    python,
    ["-c", `import numpy as np, pandas as pd, _pdv; print(_pdv.capture(${expression}))`],
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

export const FRAME_EXPRESSION = `pd.DataFrame(
  {"close": np.linspace(100.0, 200.0, 400), "sma20": np.linspace(90.0, 190.0, 400)},
  index=pd.date_range("2025-01-01", periods=400, freq="B"),
)`;

let cached: TestCapture | undefined;

/** A two-column DataFrame on a DatetimeIndex -- the case that came out empty. */
export function frameCapture(): TestCapture {
  cached ??= captureExpression(FRAME_EXPRESSION);
  return cached;
}
