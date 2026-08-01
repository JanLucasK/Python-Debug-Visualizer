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
 * Paused-ness is *derived from state*, not accumulated from events. VS Code
 * exposes a stack item only while a session is stopped, so asking for one
 * answers the question directly.
 *
 * The distinction matters more than it sounds. An earlier version tracked
 * `stopped` and `continued` events in a set, which is fine until the extension
 * starts up in the middle of an already-paused session — after a window reload
 * or a reinstall, both routine while developing. The events had already been
 * sent, the new tracker never saw them, and the extension insisted the debugger
 * was running while it sat plainly stopped. Reading the state cannot go stale
 * that way.
 *
 * The adapter tracker is still registered, but only to learn *when* to
 * re-evaluate. Nothing depends on having witnessed every event.
 */
export class SessionTracker implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<void>();

  private runtimeReady = false;
  private runtimeError: string | null = null;

  readonly onDidChange = this.changeEmitter.event;

  constructor() {
    this.disposables.push(
      this.changeEmitter,
      vscode.debug.onDidChangeActiveDebugSession(() => this.emitChange()),
      vscode.debug.onDidChangeActiveStackItem(() => this.emitChange()),
      vscode.debug.onDidTerminateDebugSession(() => this.emitChange()),
    );

    for (const type of SUPPORTED_TYPES) {
      this.disposables.push(
        vscode.debug.registerDebugAdapterTrackerFactory(type, {
          createDebugAdapterTracker: () => ({
            onDidSendMessage: (message: { type?: string; event?: string }) => {
              // A nudge to re-read the state, not the state itself.
              if (
                message.type === "event" &&
                (message.event === "stopped" || message.event === "continued")
              ) {
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
      // A selected stack frame exists only while stopped, so its presence is
      // the answer rather than evidence towards it.
      status: currentFrameId() !== undefined ? "stopped" : "running",
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
