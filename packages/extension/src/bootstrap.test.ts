import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeEnvelope } from "./debug/envelope";
import { BOOTSTRAP_EXPRESSION, RUNTIME_VERSION } from "./generated/bootstrap";

const venvPython = resolve(__dirname, "..", "..", "..", ".venv", "bin", "python");
const python = existsSync(venvPython) ? venvPython : "python3";

/**
 * Runs Python with nothing of ours on its path.
 *
 * The Python test suite covers the loader using a source map it builds itself,
 * and this file covers the loader using the map the *Node build* produced.
 * Neither alone would catch the two drifting apart, which is the failure that
 * would ship a broken extension while every test stayed green.
 */
function runIsolated(script: string): string {
  return execFileSync(python, ["-c", script], {
    // Deliberately no PYTHONPATH: the runtime has to arrive through the
    // bootstrap expression or not at all.
    env: { PATH: process.env.PATH ?? "" },
    encoding: "utf8",
    timeout: 60_000,
  }).trim();
}

describe("generated bootstrap", () => {
  it("installs the runtime into an interpreter that has never seen it", () => {
    const output = runIsolated(
      `${BOOTSTRAP_EXPRESSION}\nprint(__import__("_pdv").RUNTIME_VERSION)`,
    );
    expect(output).toBe(RUNTIME_VERSION);
  });

  it("captures a value end to end through the packed runtime", () => {
    const output = runIsolated(
      `${BOOTSTRAP_EXPRESSION}\nprint(__import__("_pdv").capture([1.0, 2.0, 3.0]), end="")`,
    );
    const { document, payload } = decodeEnvelope(output);
    const parsed = document as { ok: boolean; descriptor: { stats: { max: number } } };

    expect(parsed.ok).toBe(true);
    expect(parsed.descriptor.stats.max).toBe(3);
    expect(new Float64Array(payload.buffer, payload.byteOffset, 3)).toEqual(
      new Float64Array([1, 2, 3]),
    );
  });

  it("is a single expression, so it evaluates in eval-only debug contexts", () => {
    // DAP's `clipboard` context does not permit statements. If the bootstrap
    // ever grows into one, it stops working in exactly the context chosen for
    // its lack of truncation -- and it would fail silently at runtime, far from
    // here. `eval` accepts expressions only, so it is the check.
    expect(() =>
      runIsolated(`eval(${JSON.stringify(BOOTSTRAP_EXPRESSION)})\nprint("ok")`),
    ).not.toThrow();
  });

  it("stays small enough to send as an evaluate request", () => {
    // Sent once per debug session. There is no hard protocol limit, but this
    // catches an accidental order-of-magnitude regression in the packer.
    expect(BOOTSTRAP_EXPRESSION.length).toBeLessThan(128 * 1024);
  });
});
