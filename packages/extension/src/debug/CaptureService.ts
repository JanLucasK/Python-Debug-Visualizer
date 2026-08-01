import { readFile, unlink } from "node:fs/promises";
import {
  type CaptureError,
  PROTOCOL_VERSION,
  type ResolvedCapture,
  type VizKind,
  type VizOptions,
  captureResponseSchema,
} from "@python-debug-visualizer/protocol";
import { log } from "../log";
import type { PayloadServer } from "../transport/PayloadServer";
import type { Bootstrapper } from "./Bootstrapper";
import { EvaluateError, evaluate } from "./Evaluator";
import type { SessionTracker } from "./SessionTracker";
import { EnvelopeError, decodeEnvelope } from "./envelope";

/** A capture that did not happen, in a form the UI can render as a card. */
export class CaptureFailure extends Error {
  constructor(readonly detail: CaptureError) {
    super(detail.message);
    this.name = "CaptureFailure";
  }
}

export interface CaptureRequest {
  expression: string;
  /**
   * The visualization this capture is for, or `"auto"`.
   *
   * It reaches Python because some visualizations are reductions rather than
   * views: a histogram wants bin counts, and computing those in the debuggee is
   * what keeps five million points from crossing the wire to draw sixty bars.
   */
  viz: VizKind | "auto";
  options: VizOptions;
  sequence: number;
}

/** How long the debuggee has to deliver a payload it said it sent. */
const PAYLOAD_TIMEOUT_MS = 30_000;

export class CaptureService {
  constructor(
    private readonly tracker: SessionTracker,
    private readonly bootstrapper: Bootstrapper,
    private readonly payloads: PayloadServer,
  ) {}

  async capture({ expression, viz, options, sequence }: CaptureRequest): Promise<ResolvedCapture> {
    const context = this.tracker.context;
    if (!context) {
      throw new CaptureFailure({
        type: "NotStopped",
        message: "Start a Python debug session and pause it to evaluate expressions.",
        traceback: null,
      });
    }

    try {
      await this.bootstrapper.ensure(context);
      this.tracker.setRuntimeStatus(true, null);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.tracker.setRuntimeStatus(false, message);
      throw new CaptureFailure({
        type: "RuntimeUnavailable",
        message: `Could not install the visualizer runtime in the debuggee: ${message}`,
        traceback: null,
      });
    }

    // The listener and its token are prepared *before* evaluating, because the
    // debuggee can connect and finish sending while the evaluate response is
    // still in flight. Registering afterwards would lose that race now and
    // then, which is the worst way for it to fail.
    let port = 0;
    try {
      port = await this.payloads.ensureListening();
    } catch (cause) {
      log.warn(`No payload listener; large captures fall back to a file or inline. ${cause}`);
    }
    const reservation = port ? this.payloads.expect(0, PAYLOAD_TIMEOUT_MS) : undefined;
    // Nothing awaits this unless the runtime says it used the socket, and an
    // unobserved rejection would otherwise be reported as unhandled.
    reservation?.bytes.catch(() => undefined);

    const call = buildCaptureExpression(expression, viz, options, {
      port,
      token: reservation?.token,
    });

    let raw: string;
    try {
      raw = await evaluate({
        session: context.session,
        expression: call,
        frameId: context.frameId,
      });
    } catch (cause) {
      if (reservation) this.payloads.cancel(reservation.token);
      // An evaluate failure here is almost always the user's expression not
      // compiling or a name not existing, so report it as such rather than as
      // an internal error.
      throw new CaptureFailure({
        type: "ExpressionError",
        message: cause instanceof EvaluateError ? cause.message : String(cause),
        traceback: null,
      });
    }

    let decoded: ReturnType<typeof decodeEnvelope>;
    try {
      decoded = decodeEnvelope(raw);
    } catch (cause) {
      if (cause instanceof EnvelopeError) log.error(cause.message, cause.raw.slice(0, 2000));
      throw new CaptureFailure({
        type: "ProtocolError",
        message: cause instanceof Error ? cause.message : String(cause),
        traceback: null,
      });
    }

    const version = (decoded.document as { v?: unknown }).v;
    if (version !== PROTOCOL_VERSION) {
      // Refuse rather than guess. A half-understood descriptor yields a plot
      // that is wrong, and a wrong plot is worse than a missing one.
      throw new CaptureFailure({
        type: "ProtocolError",
        message:
          `The runtime speaks protocol version ${String(version)} but this extension expects ` +
          `${PROTOCOL_VERSION}. Restart the debug session to reinstall the runtime.`,
        traceback: null,
      });
    }

    const parsed = captureResponseSchema.safeParse(decoded.document);
    if (!parsed.success) {
      log.error("Capture failed schema validation", parsed.error.toString());
      throw new CaptureFailure({
        type: "ProtocolError",
        message: `The runtime returned a malformed capture: ${parsed.error.issues[0]?.message ?? "unknown"}`,
        traceback: null,
      });
    }

    if (!parsed.data.ok) {
      throw new CaptureFailure(parsed.data.error);
    }

    const { descriptor, warnings, elapsedMs, payload } = parsed.data;

    if (payload.encoding !== "socket" && reservation) {
      this.payloads.cancel(reservation.token);
    }

    let bytes: Uint8Array | null;
    try {
      bytes = await this.resolvePayload(payload, decoded.payload, reservation?.bytes);
    } catch (cause) {
      throw new CaptureFailure({
        type: "TransportError",
        message: cause instanceof Error ? cause.message : String(cause),
        traceback: null,
      });
    }

    return {
      expression,
      descriptor,
      bytes,
      warnings,
      elapsedMs,
      capturedAt: Date.now(),
      sequence,
    };
  }

  /**
   * The payload bytes, whichever route they took.
   *
   * The three encodings exist because no single one works everywhere, and the
   * runtime picks by size and by what succeeded. The webview never learns which
   * was used -- it receives bytes -- which is what keeps transport work out of
   * the UI.
   */
  private async resolvePayload(
    payload: { encoding: string; path?: string },
    inline: Uint8Array,
    fromSocket: Promise<Uint8Array> | undefined,
  ): Promise<Uint8Array | null> {
    switch (payload.encoding) {
      case "none":
        return null;
      case "inline":
        return inline;
      case "socket": {
        if (!fromSocket) {
          throw new Error("The runtime used the socket transport without a reservation.");
        }
        return await fromSocket;
      }
      case "file": {
        if (!payload.path) throw new Error("The runtime reported a file payload with no path.");
        const contents = await readFile(payload.path);
        // Removed as soon as it is read. The runtime also sweeps stale files,
        // but that is a backstop for captures nobody collected, not a licence
        // to leave them lying around.
        void unlink(payload.path).catch(() => undefined);
        return new Uint8Array(contents);
      }
      default:
        throw new Error(`Unknown payload encoding ${payload.encoding}.`);
    }
  }
}

/**
 * Wraps the user's expression in a call to the runtime.
 *
 * Both the call and its options are assembled as Python source text, so the
 * options ride along as base64 rather than as JSON: JSON contains quotes, and a
 * quoting layer here would be one more place for a stray backslash to break
 * something. The user's own expression is interpolated verbatim — a malformed
 * one produces a Python SyntaxError, which is exactly the feedback they want.
 */
function buildCaptureExpression(
  expression: string,
  viz: VizKind | "auto",
  options: VizOptions,
  transport: { port: number; token: string | undefined },
): string {
  const runtimeOptions: Record<string, unknown> = {};
  // Omitted for "auto" so the adapter picks, since it is the side that just
  // looked at the value.
  if (viz !== "auto") runtimeOptions.viz = viz;
  if (options.maxPoints !== undefined) runtimeOptions.maxPoints = options.maxPoints;
  if (options.bins !== undefined) runtimeOptions.bins = options.bins;
  if (options.range !== undefined) runtimeOptions.range = options.range;
  if (transport.port && transport.token) {
    runtimeOptions.transport = { port: transport.port, token: transport.token };
  }

  const encoded = Buffer.from(JSON.stringify(runtimeOptions), "utf8").toString("base64");
  const call = `__import__("_pdv").capture(${expression}, "${encoded}"`;

  // The x axis travels as a real argument rather than inside the options,
  // because it is data: forcing an array through JSON would cost the precision
  // and the size the binary channels exist to protect.
  const axis = options.xSource;
  if (axis !== undefined && axis !== "index" && axis.trim().length > 0) {
    return `${call}, ${axis})`;
  }
  return `${call})`;
}
