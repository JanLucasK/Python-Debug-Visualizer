import {
  type CaptureError,
  PROTOCOL_VERSION,
  type ResolvedCapture,
  type VizOptions,
  captureResponseSchema,
} from "@python-debug-visualizer/protocol";
import { log } from "../log";
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
  options: VizOptions;
  sequence: number;
}

export class CaptureService {
  constructor(
    private readonly tracker: SessionTracker,
    private readonly bootstrapper: Bootstrapper,
  ) {}

  async capture({ expression, options, sequence }: CaptureRequest): Promise<ResolvedCapture> {
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

    const call = buildCaptureExpression(expression, options);

    let raw: string;
    try {
      raw = await evaluate({
        session: context.session,
        expression: call,
        frameId: context.frameId,
      });
    } catch (cause) {
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
    return {
      expression,
      descriptor,
      bytes: payload.encoding === "inline" ? decoded.payload : null,
      warnings,
      elapsedMs,
      capturedAt: Date.now(),
      sequence,
    };
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
function buildCaptureExpression(expression: string, options: VizOptions): string {
  const runtimeOptions: Record<string, unknown> = {};
  if (options.maxPoints !== undefined) runtimeOptions.maxPoints = options.maxPoints;
  if (options.bins !== undefined) runtimeOptions.bins = options.bins;

  const encoded = Buffer.from(JSON.stringify(runtimeOptions), "utf8").toString("base64");
  return `__import__("_pdv").capture(${expression}, "${encoded}")`;
}
