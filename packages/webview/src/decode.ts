import {
  BYTES_PER_ELEMENT,
  type Channel,
  type Descriptor,
  isBigIntDtype,
  typedArrayFor,
} from "@python-debug-visualizer/protocol";

/**
 * Largest integer JavaScript can represent exactly. Beyond this, converting an
 * int64 to a double silently rounds — which for a debugging tool is a lie worth
 * flagging rather than hiding.
 */
const MAX_EXACT_INTEGER = Number.MAX_SAFE_INTEGER;

export interface DecodedChannel {
  channel: Channel;
  values: Float64Array;
  /** Set when int64 values exceeded the exact-integer range and were rounded. */
  precisionLoss: boolean;
}

export interface DecodedCapture {
  channels: Map<string, DecodedChannel>;
  warnings: string[];
}

export function decodeChannels(descriptor: Descriptor, bytes: Uint8Array | null): DecodedCapture {
  const channels = new Map<string, DecodedChannel>();
  const warnings: string[] = [];

  if (!bytes) return { channels, warnings };

  for (const channel of descriptor.channels) {
    const decoded = decodeChannel(channel, bytes);
    channels.set(channel.name, decoded);
    if (decoded.precisionLoss) {
      warnings.push(
        `Channel "${channel.name}" holds integers larger than 2^53; plotted values are rounded.`,
      );
    }
  }

  return { channels, warnings };
}

function decodeChannel(channel: Channel, bytes: Uint8Array): DecodedChannel {
  const Ctor = typedArrayFor(channel.dtype);
  const { buffer, offset } = viewableRegion(channel, bytes);
  const source = new Ctor(buffer, offset, channel.length);

  const values = new Float64Array(channel.length);
  let precisionLoss = false;

  if (isBigIntDtype(channel.dtype)) {
    const big = source as BigInt64Array | BigUint64Array;
    for (let i = 0; i < values.length; i++) {
      const value = big[i] as bigint;
      const asNumber = Number(value);
      if (!precisionLoss && (asNumber > MAX_EXACT_INTEGER || asNumber < -MAX_EXACT_INTEGER)) {
        precisionLoss = true;
      }
      values[i] = asNumber;
    }
  } else {
    values.set(source as unknown as ArrayLike<number>);
  }

  return { channel, values, precisionLoss };
}

/**
 * A buffer region a typed array can be laid over.
 *
 * Typed array views require their byte offset to be a multiple of the element
 * size. Channels are packed end to end, so a 1-byte channel sitting ahead of an
 * 8-byte one can leave it on an odd boundary. Copying that channel into a fresh
 * buffer is the cheap, total fix, and it also covers the case where the
 * incoming bytes are backed by something other than a plain ArrayBuffer.
 */
function viewableRegion(
  channel: Channel,
  bytes: Uint8Array,
): { buffer: ArrayBuffer; offset: number } {
  const absoluteOffset = bytes.byteOffset + channel.byteOffset;
  const aligned = absoluteOffset % BYTES_PER_ELEMENT[channel.dtype] === 0;

  if (aligned && bytes.buffer instanceof ArrayBuffer) {
    return { buffer: bytes.buffer, offset: absoluteOffset };
  }

  const copy = new ArrayBuffer(channel.byteLength);
  new Uint8Array(copy).set(
    bytes.subarray(channel.byteOffset, channel.byteOffset + channel.byteLength),
  );
  return { buffer: copy, offset: 0 };
}

/**
 * The x values for a series.
 *
 * When the payload was decimated the runtime sends explicit positions, because
 * the remaining points are no longer at 0..n-1 and plotting them as if they
 * were would stretch the series across the wrong range.
 */
export function xValuesFor(decoded: DecodedCapture, length: number): Float64Array {
  const explicit = decoded.channels.get("x");
  if (explicit && explicit.values.length === length) return explicit.values;

  const positions = new Float64Array(length);
  for (let i = 0; i < length; i++) positions[i] = i;
  return positions;
}
