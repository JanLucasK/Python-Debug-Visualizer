import { z } from "zod";

/**
 * Element types that may appear in a binary channel.
 *
 * This is deliberately much smaller than NumPy's dtype zoo: the Python side is
 * responsible for narrowing anything exotic (float16, datetime64, categorical,
 * ...) down to one of these before it goes on the wire, and for recording what
 * the *original* dtype was in `Descriptor.dtype`. That keeps the decoder in the
 * webview trivial and total — every value it can receive has exactly one
 * corresponding JS TypedArray.
 */
export const wireDtypeSchema = z.enum([
  "f32",
  "f64",
  "i8",
  "i16",
  "i32",
  "i64",
  "u8",
  "u16",
  "u32",
  "u64",
  "bool",
]);
export type WireDtype = z.infer<typeof wireDtypeSchema>;

export const BYTES_PER_ELEMENT: Record<WireDtype, number> = {
  f32: 4,
  f64: 8,
  i8: 1,
  i16: 2,
  i32: 4,
  i64: 8,
  u8: 1,
  u16: 2,
  u32: 4,
  u64: 8,
  bool: 1,
};

/**
 * All payloads are little-endian. Every platform VS Code ships on is
 * little-endian, so rather than carrying a byte-order flag we assert it on both
 * sides and fail loudly if that ever stops being true.
 */
export const WIRE_ENDIANNESS = "little" as const;

type TypedArrayCtor =
  | Float32ArrayConstructor
  | Float64ArrayConstructor
  | Int8ArrayConstructor
  | Int16ArrayConstructor
  | Int32ArrayConstructor
  | BigInt64ArrayConstructor
  | Uint8ArrayConstructor
  | Uint16ArrayConstructor
  | Uint32ArrayConstructor
  | BigUint64ArrayConstructor;

const TYPED_ARRAY_CTOR: Record<WireDtype, TypedArrayCtor> = {
  f32: Float32Array,
  f64: Float64Array,
  i8: Int8Array,
  i16: Int16Array,
  i32: Int32Array,
  i64: BigInt64Array,
  u8: Uint8Array,
  u16: Uint16Array,
  u32: Uint32Array,
  u64: BigUint64Array,
  bool: Uint8Array,
};

export function typedArrayFor(dtype: WireDtype): TypedArrayCtor {
  return TYPED_ARRAY_CTOR[dtype];
}

/** 64-bit integers decode to BigInt arrays, which most plotting code cannot consume directly. */
export function isBigIntDtype(dtype: WireDtype): boolean {
  return dtype === "i64" || dtype === "u64";
}
