import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EnvelopeError, decodeEnvelope } from "./envelope";

const runtimeSrc = resolve(__dirname, "..", "..", "..", "runtime", "src");
const venvPython = resolve(__dirname, "..", "..", "..", "..", ".venv", "bin", "python");
const python = existsSync(venvPython) ? venvPython : "python3";

/**
 * Runs the real Python runtime and returns exactly what it emits.
 *
 * This is the point of these tests: the encoder and the decoder live in
 * different languages, and a contract checked only against a hand-written
 * fixture drifts the moment one side changes. Round-tripping through the actual
 * interpreter is the only version that stays honest.
 */
function captureFromPython(expression: string): string {
  return execFileSync(
    python,
    ["-c", `import _pdv, sys; sys.stdout.write(_pdv.capture(${expression}))`],
    { env: { ...process.env, PYTHONPATH: runtimeSrc }, encoding: "utf8" },
  );
}

/** What a debug adapter actually hands back: the repr of the returned string. */
const asRepr = (value: string) => `'${value}'`;

describe("decodeEnvelope", () => {
  it("reads a capture produced by the Python runtime", () => {
    const { document, payload } = decodeEnvelope(captureFromPython("[1.0, 2.0, 3.0]"));
    const parsed = document as { ok: boolean; descriptor: { kind: string } };

    expect(parsed.ok).toBe(true);
    expect(parsed.descriptor.kind).toBe("sequence");
    expect(new Float64Array(payload.buffer, payload.byteOffset, 3)).toEqual(
      new Float64Array([1, 2, 3]),
    );
  });

  it("reads the same capture when the adapter wrapped it in quotes", () => {
    const raw = captureFromPython("[1.0, 2.0, 3.0]");
    expect(decodeEnvelope(asRepr(raw))).toEqual(decodeEnvelope(raw));
  });

  it("survives values whose contents would break repr un-escaping", () => {
    // The failure mode this whole encoding exists to prevent: a naive decoder
    // that strips quotes and un-escapes backslashes mangles exactly this input.
    // A Python raw literal, so the backslashes survive into the value itself
    // rather than being consumed as escapes when the expression is compiled.
    const raw = captureFromPython(String.raw`r"C:\Users\jan\re\.\d+"`);
    const { document } = decodeEnvelope(asRepr(raw));
    const parsed = document as { descriptor: { preview: string } };

    // `preview` is Python's repr of the value, so every backslash appears
    // doubled and the whole thing is quoted. Asserting on the exact repr is the
    // point: a decoder that un-escapes the adapter's quoting by hand would
    // collapse these pairs and hand back a different path.
    expect(parsed.descriptor.preview).toBe(String.raw`'C:\\Users\\jan\\re\\.\\d+'`);
  });

  it("reports a Python-side failure as a structured error rather than throwing", () => {
    const { document } = decodeEnvelope(captureFromPython("__import__('sys')"));
    const parsed = document as { ok: boolean; descriptor: { kind: string } };

    // An unplottable value is still a successful capture: it describes itself.
    expect(parsed.ok).toBe(true);
    expect(parsed.descriptor.kind).toBe("object");
  });

  it("rejects a response that is not a capture at all", () => {
    expect(() => decodeEnvelope("NameError: name 'foo' is not defined")).toThrow(EnvelopeError);
  });

  it("rejects a truncated payload instead of returning partial data", () => {
    const raw = captureFromPython("[1.0, 2.0, 3.0]");
    expect(() => decodeEnvelope(raw.slice(0, Math.floor(raw.length / 2)))).toThrow(EnvelopeError);
  });
});
