import { z } from "zod";
import { PROTOCOL_VERSION, descriptorSchema } from "./descriptor";

/**
 * How the bulk bytes travel from the debuggee to the extension host.
 *
 * The three encodings exist because no single one works everywhere:
 *
 * - `inline` rides along in the DAP evaluate response. One round trip, no
 *   sockets, works in every conceivable setup — but base64 in a JSON string is
 *   expensive, so it is only used below a size threshold.
 * - `socket` has the debuggee dial back to a loopback listener in the extension
 *   host. Fast and unbounded. Safe over Remote-SSH and dev containers because
 *   the extension host runs on the *same* machine as the debuggee there.
 * - `file` is the fallback for the one topology where loopback fails: debuggee
 *   and extension host in different containers sharing a volume.
 */
export const payloadSchema = z.discriminatedUnion("encoding", [
  z.object({ encoding: z.literal("none") }),
  z.object({
    encoding: z.literal("inline"),
    /** Bytes are appended after the JSON inside the envelope; see `ENVELOPE.md`. */
    byteLength: z.number().int().nonnegative(),
  }),
  z.object({
    encoding: z.literal("socket"),
    /** Single-use token the debuggee presents when connecting back. */
    token: z.string(),
    byteLength: z.number().int().nonnegative(),
  }),
  z.object({
    encoding: z.literal("file"),
    /** Path as seen by the *debuggee*. */
    path: z.string(),
    byteLength: z.number().int().nonnegative(),
  }),
]);
export type Payload = z.infer<typeof payloadSchema>;

export const pythonErrorSchema = z.object({
  /** Python exception class name, or a sentinel like "ExpressionError". */
  type: z.string(),
  message: z.string(),
  traceback: z.string().nullable(),
});
export type PythonError = z.infer<typeof pythonErrorSchema>;

const captureSuccessSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  ok: z.literal(true),
  descriptor: descriptorSchema,
  payload: payloadSchema,
  /** Non-fatal notes to surface in the UI, e.g. "3 non-numeric columns skipped". */
  warnings: z.array(z.string()),
  /** Time spent inside the debuggee, in milliseconds. */
  elapsedMs: z.number().nonnegative(),
});

const captureFailureSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  ok: z.literal(false),
  error: pythonErrorSchema,
});

/**
 * What `_pdv.capture(...)` returns, as parsed from the debuggee.
 *
 * This is the only boundary in the system that is genuinely untrusted: the
 * value crossing it was produced by a Python process we do not control, running
 * a version of the runtime that may not match ours. Hence full schema
 * validation here, and plain TypeScript types everywhere else.
 */
export const captureResponseSchema = z.discriminatedUnion("ok", [
  captureSuccessSchema,
  captureFailureSchema,
]);
export type CaptureResponse = z.infer<typeof captureResponseSchema>;
export type CaptureSuccess = z.infer<typeof captureSuccessSchema>;
export type CaptureFailure = z.infer<typeof captureFailureSchema>;

/**
 * A capture after the extension host has resolved its payload to actual bytes.
 *
 * The webview only ever sees this shape — it has no notion of transports, which
 * is what keeps transport work (M4) from rippling into the UI.
 */
export interface ResolvedCapture {
  expression: string;
  descriptor: CaptureSuccess["descriptor"];
  /** Concatenated channel data, or null for values with no numeric payload. */
  bytes: Uint8Array | null;
  warnings: string[];
  /** Wall-clock time in the debuggee. */
  elapsedMs: number;
  /** Stamped by the extension host, not by Python. */
  capturedAt: number;
  /** Monotonic per-pane counter, used to order and to key history entries. */
  sequence: number;
}
