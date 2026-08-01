import { inflateSync } from "node:zlib";

/**
 * Decoder for the envelope produced by `_pdv.envelope.encode`.
 *
 * The input is whatever a DAP `evaluate` request returned, which is normally the
 * debug adapter's *repr* of the runtime's return value — so `'BASE64'`, with
 * quotes. Some adapters honour `format: { rawString: true }` and return the
 * bare string instead.
 *
 * Rather than branching on which happened, this scans for the longest run of
 * base64 characters. Because the runtime emits nothing outside that alphabet
 * (see the module docstring in `_pdv/envelope.py`), the run is the payload and
 * the quotes are the only thing outside it. That is what makes this decoder
 * total instead of a pile of un-escaping heuristics.
 */

const BASE64_RUN = /[A-Za-z0-9+/=]{16,}/g;
const HEADER_BYTES = 4;

export class EnvelopeError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = "EnvelopeError";
  }
}

export interface DecodedEnvelope {
  document: unknown;
  payload: Uint8Array;
}

export function decodeEnvelope(raw: string): DecodedEnvelope {
  const encoded = longestBase64Run(raw);
  if (encoded === undefined) {
    throw new EnvelopeError(
      `The debuggee returned something that is not a capture: ${summarize(raw)}`,
      raw,
    );
  }

  let body: Buffer;
  try {
    body = inflateSync(Buffer.from(encoded, "base64"));
  } catch (cause) {
    throw new EnvelopeError(
      `Capture payload could not be decompressed: ${(cause as Error).message}`,
      raw,
    );
  }

  if (body.length < HEADER_BYTES) {
    throw new EnvelopeError("Capture payload is truncated.", raw);
  }

  const jsonLength = body.readUInt32LE(0);
  const jsonEnd = HEADER_BYTES + jsonLength;
  if (jsonEnd > body.length) {
    throw new EnvelopeError(
      `Capture header claims ${jsonLength} bytes of JSON but only ${body.length - HEADER_BYTES} are present.`,
      raw,
    );
  }

  let document: unknown;
  try {
    document = JSON.parse(body.subarray(HEADER_BYTES, jsonEnd).toString("utf8"));
  } catch (cause) {
    throw new EnvelopeError(`Capture metadata is not valid JSON: ${(cause as Error).message}`, raw);
  }

  // Copied rather than viewed: structured-cloning a view over this Buffer would
  // carry the JSON and Node's shared pool along with it to the webview.
  const payload = new Uint8Array(body.length - jsonEnd);
  payload.set(body.subarray(jsonEnd));

  return { document, payload };
}

function longestBase64Run(raw: string): string | undefined {
  let best: string | undefined;
  for (const match of raw.matchAll(BASE64_RUN)) {
    if (best === undefined || match[0].length > best.length) {
      best = match[0];
    }
  }
  return best;
}

function summarize(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return collapsed.length > 200 ? `${collapsed.slice(0, 200)}…` : collapsed;
}
