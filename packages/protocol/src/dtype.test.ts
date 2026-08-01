import { describe, expect, it } from "vitest";
import {
  BYTES_PER_ELEMENT,
  type WireDtype,
  isBigIntDtype,
  typedArrayFor,
  wireDtypeSchema,
} from "./dtype";

const ALL_DTYPES = wireDtypeSchema.options as readonly WireDtype[];

describe("wire dtypes", () => {
  it("agrees with the JavaScript typed arrays about element size", () => {
    // Two tables describing the same fact drift apart eventually, and when they
    // do the symptom is a channel decoded at the wrong stride — plausible
    // numbers, entirely wrong. Pinning them together is cheap insurance.
    for (const dtype of ALL_DTYPES) {
      const expected = dtype === "bool" ? 1 : typedArrayFor(dtype).BYTES_PER_ELEMENT;
      expect(BYTES_PER_ELEMENT[dtype], dtype).toBe(expected);
    }
  });

  it("has an entry for every dtype in the schema", () => {
    for (const dtype of ALL_DTYPES) {
      expect(BYTES_PER_ELEMENT[dtype], dtype).toBeGreaterThan(0);
      expect(typedArrayFor(dtype), dtype).toBeTypeOf("function");
    }
  });

  it("flags exactly the dtypes that decode to BigInt arrays", () => {
    const bigint = ALL_DTYPES.filter(isBigIntDtype);
    expect(bigint).toEqual(["i64", "u64"]);

    for (const dtype of ALL_DTYPES) {
      const Ctor = typedArrayFor(dtype);
      const producesBigInt = Ctor === BigInt64Array || Ctor === BigUint64Array;
      expect(producesBigInt, dtype).toBe(isBigIntDtype(dtype));
    }
  });

  it("maps bool to a byte-wide array", () => {
    // The runtime widens numpy's bool_ to uint8 rather than packing bits, so
    // the decoder must not try to unpack anything.
    expect(typedArrayFor("bool")).toBe(Uint8Array);
    expect(BYTES_PER_ELEMENT.bool).toBe(1);
  });
});
