import type { ResolvedCapture } from "./capture";
import type { VizKind } from "./descriptor";

/**
 * Per-visualization knobs. All optional: an unset option means "let the
 * adapter's suggestion or the renderer's default win", which keeps persisted
 * pane state forward-compatible when new options are added.
 */
export interface VizOptions {
  /**
   * Where the x axis comes from. `"auto"` lets the descriptor decide (a
   * DatetimeIndex becomes time, otherwise position). Any other string is
   * evaluated as a second Python expression.
   */
  xSource?: "auto" | "index" | "position" | (string & {});
  logX?: boolean;
  logY?: boolean;
  /** Colormap name for heatmap/image, e.g. "viridis". */
  colormap?: string;
  /** Histogram bin count; unset means Freedman-Diaconis. */
  bins?: number;
  /** Upper bound on transferred points before decimation kicks in. */
  maxPoints?: number;
  /** Column/series names to show; unset means all numeric ones. */
  series?: string[];
}

export interface PaneSpec {
  id: string;
  expression: string;
  /** `"auto"` follows `Descriptor.suggestedViz`. */
  viz: VizKind | "auto";
  options: VizOptions;
  /** Frozen panes keep their last capture and are skipped on refresh. */
  frozen: boolean;
}

export interface SessionState {
  status: "no-session" | "running" | "stopped" | "unsupported";
  /** The debug adapter type, e.g. "debugpy". */
  sessionType: string | null;
  /** Whether the Python runtime has been injected into the debuggee. */
  runtimeReady: boolean;
  /** Populated when bootstrapping failed, so the UI can explain itself. */
  runtimeError: string | null;
}

export interface CaptureError {
  type: string;
  message: string;
  traceback: string | null;
}

export type WebviewToExtension =
  | { type: "ready" }
  | { type: "addPane"; expression: string }
  | { type: "updatePane"; pane: PaneSpec }
  | { type: "removePane"; paneId: string }
  | { type: "refresh"; paneId?: string }
  | { type: "revealTraceback"; paneId: string };

export type ExtensionToWebview =
  | {
      type: "init";
      panes: PaneSpec[];
      session: SessionState;
      /** Captures kept per pane for the history scrubber; 0 disables it. */
      historyDepth: number;
    }
  | { type: "session"; session: SessionState }
  | { type: "panes"; panes: PaneSpec[] }
  | { type: "capture"; paneId: string; capture: ResolvedCapture }
  | { type: "captureError"; paneId: string; error: CaptureError }
  | { type: "busy"; paneId: string; busy: boolean };
