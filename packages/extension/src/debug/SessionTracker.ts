import type { SessionState } from "@python-debug-visualizer/protocol";
import * as vscode from "vscode";
import { log } from "../log";

/** Debug adapter types this extension knows how to talk to. */
const SUPPORTED_TYPES = new Set(["debugpy", "python"]);

export interface DebugContext {
  session: vscode.DebugSession;
  /** Frame to evaluate against. Without it debugpy evaluates against a synthetic
   *  global frame, where none of the user's locals are in scope. */
  frameId: number;
}

/**
 * Tracks which Python debug session is active, whether it is paused, and which
 * stack frame the user is looking at.
 *
 * The stopped/running state comes from a `DebugAdapterTracker` rather than from
 * polling: it observes the `stopped` and `continued` events the adapter already
 * sends, so we learn about state changes without issuing a single request of
 * our own. Sending requests to a running debuggee is at best wasted and at
 * worst disruptive.
 */
export class SessionTracker implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly stoppedSessions = new Set<string>();

  private runtimeReady = false;
  private runtimeError: string | null = null;

  readonly onDidChange = this.changeEmitter.event;

  constructor() {
    this.disposables.push(
      this.changeEmitter,
      vscode.debug.onDidChangeActiveDebugSession(() => this.emitChange()),
      vscode.debug.onDidChangeActiveStackItem(() => this.emitChange()),
      vscode.debug.onDidTerminateDebugSession((session) => {
        this.stoppedSessions.delete(session.id);
        this.emitChange();
      }),
    );

    for (const type of SUPPORTED_TYPES) {
      this.disposables.push(
        vscode.debug.registerDebugAdapterTrackerFactory(type, {
          createDebugAdapterTracker: (session) => ({
            onDidSendMessage: (message: { type?: string; event?: string }) => {
              if (message.type !== "event") return;
              if (message.event === "stopped") {
                this.stoppedSessions.add(session.id);
                this.emitChange();
              } else if (message.event === "continued") {
                this.stoppedSessions.delete(session.id);
                this.emitChange();
              }
            },
          }),
        }),
      );
    }
  }

  /**
   * The session and frame to evaluate against, or undefined when there is
   * nothing to evaluate against.
   */
  get context(): DebugContext | undefined {
    const session = vscode.debug.activeDebugSession;
    if (!session || !SUPPORTED_TYPES.has(session.type)) return undefined;
    if (!this.stoppedSessions.has(session.id)) return undefined;

    const frameId = currentFrameId();
    if (frameId === undefined) return undefined;

    return { session, frameId };
  }

  get state(): SessionState {
    const session = vscode.debug.activeDebugSession;
    if (!session) {
      return { status: "no-session", sessionType: null, runtimeReady: false, runtimeError: null };
    }
    if (!SUPPORTED_TYPES.has(session.type)) {
      return {
        status: "unsupported",
        sessionType: session.type,
        runtimeReady: false,
        runtimeError: null,
      };
    }
    return {
      status: this.stoppedSessions.has(session.id) ? "stopped" : "running",
      sessionType: session.type,
      runtimeReady: this.runtimeReady,
      runtimeError: this.runtimeError,
    };
  }

  setRuntimeStatus(ready: boolean, error: string | null): void {
    if (this.runtimeReady === ready && this.runtimeError === error) return;
    this.runtimeReady = ready;
    this.runtimeError = error;
    if (error) log.warn(`Runtime unavailable: ${error}`);
    this.emitChange();
  }

  private emitChange(): void {
    this.changeEmitter.fire();
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
  }
}

/**
 * The frame the user has selected in the Call Stack view.
 *
 * `activeStackItem` reflects that selection directly, which matters: someone
 * inspecting a caller two frames up expects expressions to resolve in *that*
 * frame, not in the innermost one.
 */
function currentFrameId(): number | undefined {
  const item = vscode.debug.activeStackItem;
  return item instanceof vscode.DebugStackFrame ? item.frameId : undefined;
}
