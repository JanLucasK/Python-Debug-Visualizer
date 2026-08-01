import type * as vscode from "vscode";

/**
 * DAP `evaluate` contexts, with the two that matter to us called out.
 *
 * `clipboard` is the important one and it is what this extension uses for
 * everything. debugpy truncates evaluate results at 64 KiB
 * (`SafeRepr.maxstring_outer = 2**16`) in every context *except* clipboard,
 * where it raises the cap to `2**64`. That single line in pydevd is the
 * difference between this tool handling real arrays and not.
 *
 * It has a second, quieter benefit: unlike `repl`, clipboard context does not
 * redirect the debuggee's stdout into the Debug Console, so injecting the
 * runtime leaves no visible output for the user to wonder about.
 *
 * Clipboard context is eval-only, which is why every expression this extension
 * sends — including the bootstrap — is written as a single expression.
 */
export type EvaluateContext = "clipboard" | "repl" | "watch" | "hover" | "variables";

export class EvaluateError extends Error {
  constructor(
    message: string,
    readonly expression: string,
  ) {
    super(message);
    this.name = "EvaluateError";
  }
}

export interface EvaluateOptions {
  session: vscode.DebugSession;
  expression: string;
  frameId: number | undefined;
  context?: EvaluateContext;
}

export async function evaluate({
  session,
  expression,
  frameId,
  context = "clipboard",
}: EvaluateOptions): Promise<string> {
  let response: { result?: unknown } | undefined;
  try {
    response = await session.customRequest("evaluate", {
      expression,
      frameId,
      context,
      // debugpy-specific: returns the string unquoted and unabridged. Harmless
      // where unsupported (DAP requires adapters to ignore unknown fields), and
      // the envelope decoder copes with either form.
      format: { rawString: true },
    });
  } catch (cause) {
    throw new EvaluateError(describeFailure(cause), expression);
  }

  if (response?.result === undefined || response.result === null) {
    throw new EvaluateError("The debug adapter returned no result.", expression);
  }
  return String(response.result);
}

function describeFailure(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  // debugpy surfaces the Python exception in the request's error message.
  return message.replace(/^Error:\s*/, "").trim() || "The evaluate request failed.";
}
