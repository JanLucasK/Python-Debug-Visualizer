import type { Channel, Descriptor } from "@python-debug-visualizer/protocol";
import { describe, expect, it } from "vitest";
import { type DecodedCapture, decodeChannels, xValuesFor } from "./decode";

/** Fails with a useful message rather than a null dereference. */
function channelValues(decoded: DecodedCapture, name: string): number[] {
  const found = decoded.channels.get(name);
  if (!found) throw new Error(`no channel ${name}; have ${[...decoded.channels.keys()]}`);
  return Array.from(found.values);
}

function precisionLoss(decoded: DecodedCapture, name: string): boolean {
  const found = decoded.channels.get(name);
  if (!found) throw new Error(`no channel ${name}`);
  return found.precisionLoss;
}

function channel(
  overrides: Partial<Channel> & Pick<Channel, "name" | "dtype" | "length">,
): Channel {
  return {
    role: "y",
    byteOffset: 0,
    byteLength: 0,
    stats: null,
    ...overrides,
  } as Channel;
}

function descriptor(channels: Channel[]): Descriptor {
  return {
    kind: "ndarray",
    pythonType: "numpy.ndarray",
    preview: "",
    shape: null,
    dtype: null,
    nbytes: null,
    stats: null,
    index: null,
    columns: null,
    channels,
    decimation: null,
    window: null,
    truncated: false,
    suggestedViz: [],
  };
}

describe("decodeChannels", () => {
  it("reads a float64 channel", () => {
    const bytes = new Uint8Array(new Float64Array([1.5, -2.5, 3]).buffer);
    const decoded = decodeChannels(
      descriptor([channel({ name: "y", dtype: "f64", length: 3, byteLength: 24 })]),
      bytes,
    );

    expect(channelValues(decoded, "y")).toEqual([1.5, -2.5, 3]);
  });

  it("preserves NaN rather than substituting a number for it", () => {
    // A NaN means "no value here". Turning it into 0 draws a line through a
    // hole in the data, which is the exact failure this project exists to avoid.
    const bytes = new Uint8Array(new Float64Array([1, Number.NaN, 3]).buffer);
    const decoded = decodeChannels(
      descriptor([channel({ name: "y", dtype: "f64", length: 3, byteLength: 24 })]),
      bytes,
    );

    expect(Number.isNaN(channelValues(decoded, "y")[1] as number)).toBe(true);
  });

  it("handles a channel that starts on an unaligned offset", () => {
    // One bool channel ahead of a float64 one leaves the float at byte 3, which
    // no typed array can be laid over directly.
    const buffer = new ArrayBuffer(3 + 16);
    new Uint8Array(buffer).set([1, 0, 1], 0);
    new DataView(buffer).setFloat64(3, 42.25, true);
    new DataView(buffer).setFloat64(11, -7.5, true);

    const decoded = decodeChannels(
      descriptor([
        channel({ name: "flags", dtype: "bool", length: 3, byteLength: 3 }),
        channel({ name: "y", dtype: "f64", length: 2, byteOffset: 3, byteLength: 16 }),
      ]),
      new Uint8Array(buffer),
    );

    expect(channelValues(decoded, "flags")).toEqual([1, 0, 1]);
    expect(channelValues(decoded, "y")).toEqual([42.25, -7.5]);
  });

  it("reports int64 values that cannot be represented exactly", () => {
    const bytes = new Uint8Array(new BigInt64Array([1n, 2n ** 60n]).buffer);
    const decoded = decodeChannels(
      descriptor([channel({ name: "y", dtype: "i64", length: 2, byteLength: 16 })]),
      bytes,
    );

    expect(precisionLoss(decoded, "y")).toBe(true);
    expect(decoded.warnings.join(" ")).toContain("rounded");
  });

  it("does not warn about int64 values inside the exact range", () => {
    const bytes = new Uint8Array(new BigInt64Array([1n, -9007199254740991n]).buffer);
    const decoded = decodeChannels(
      descriptor([channel({ name: "y", dtype: "i64", length: 2, byteLength: 16 })]),
      bytes,
    );

    expect(precisionLoss(decoded, "y")).toBe(false);
    expect(decoded.warnings).toEqual([]);
  });

  it("returns nothing for a value with no payload", () => {
    expect(decodeChannels(descriptor([]), null).channels.size).toBe(0);
  });
});

describe("xValuesFor", () => {
  it("uses the transmitted positions when the payload was decimated", () => {
    const bytes = new Uint8Array(new BigInt64Array([0n, 17n, 99n]).buffer);
    const decoded = decodeChannels(
      descriptor([channel({ name: "x", role: "x", dtype: "i64", length: 3, byteLength: 24 })]),
      bytes,
    );

    expect(Array.from(xValuesFor(decoded, 3))).toEqual([0, 17, 99]);
  });

  it("falls back to 0..n-1 when positions are implicit", () => {
    const decoded = decodeChannels(descriptor([]), null);
    expect(Array.from(xValuesFor(decoded, 4))).toEqual([0, 1, 2, 3]);
  });
});
