import type * as vscode from "vscode";
import { BOOTSTRAP_EXPRESSION, RUNTIME_BUILD } from "../generated/bootstrap";
import { log } from "../log";
import { evaluate } from "./Evaluator";
import type { DebugContext } from "./SessionTracker";
import { decodeEnvelope } from "./envelope";

/**
 * Installs the Python runtime into a debug session, once.
 *
 * Injection is used instead of asking the user to `pip install` anything. That
 * is the difference between a tool that works and one that does not: the
 * interpreter under debug is frequently one the user does not directly control
 * — a virtualenv, a container, a remote host, a Lambda-style sandbox — and
 * "install this package first" fails in all of them.
 */
export class Bootstrapper {
  /** Keyed by session id; the promise is the in-flight or completed install. */
  private readonly installs = new Map<string, Promise<void>>();

  async ensure({ session, frameId }: DebugContext): Promise<void> {
    let install = this.installs.get(session.id);
    if (install === undefined) {
      install = this.install(session, frameId);
      this.installs.set(session.id, install);
    }

    try {
      await install;
    } catch (error) {
      // Retry on the next capture rather than poisoning the session forever:
      // the usual cause is a transient one, such as evaluating while the
      // debuggee happened to be inside a C extension.
      this.installs.delete(session.id);
      throw error;
    }
  }

  forget(sessionId: string): void {
    this.installs.delete(sessionId);
  }

  private async install(session: vscode.DebugSession, frameId: number): Promise<void> {
    const started = Date.now();
    await evaluate({ session, expression: BOOTSTRAP_EXPRESSION, frameId });

    // Verify rather than assume. `exec` returns None whether or not the loader
    // worked, so a successful evaluate proves nothing on its own.
    const raw = await evaluate({
      session,
      expression: '__import__("_pdv").diagnostics()',
      frameId,
    });
    const { document } = decodeEnvelope(raw);
    const report = document as { build?: string; adapters?: string[] };

    // Compared against the build rather than the release version, so a stale
    // runtime left in a long-running session is detected rather than accepted.
    if (report.build !== RUNTIME_BUILD) {
      throw new Error(
        `Runtime reported build ${report.build ?? "unknown"}, expected ${RUNTIME_BUILD}.`,
      );
    }

    log.info(
      `Runtime ${RUNTIME_BUILD} installed in session ${session.name} in ${Date.now() - started} ms ` +
        `(adapters: ${(report.adapters ?? []).join(", ")})`,
    );
  }
}
