import type { ResolvedCapture } from "./capture";
import type { VizKind } from "./descriptor";

/**
 * Per-visualization knobs. All optional: an unset option means "let the
 * adapter's suggestion or the renderer's default win", which keeps persisted
 * pane state forward-compatible when new options are added.
 */
export interface VizOptions {
  /**
   * Where the x axis comes from.
   *
   * `"index"` uses the value's own index or position. Anything else is
   * evaluated as a second Python expression in the same frame, so
   * `prices["volume"]` plots one column against another.
   */
  xSource?: "index" | (string & {});
  logX?: boolean;
  logY?: boolean;
  /** Colormap name for heatmap, e.g. "viridis". */
  colormap?: string;
  /** Histogram bin count; unset means Freedman-Diaconis. */
  bins?: number;
  /** Upper bound on transferred points before decimation kicks in. */
  maxPoints?: number;
  /**
   * Restricts the capture to a window of the x axis, in the units the webview
   * received. Set when zooming, so the runtime can decimate within the visible
   * range instead of across the whole value.
   */
  range?: [number, number];
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
  /**
   * Re-capture within a zoomed x range, so the runtime can spend the point
   * budget inside the visible window instead of across the whole value.
   *
   * `range` of null means the user zoomed back out.
   */
  | { type: "zoom"; paneId: string; range: [number, number] | null }
  | { type: "revealTraceback"; paneId: string };

export type ExtensionToWebview =
  | {
      type: "init";
      panes: PaneSpec[];
      session: SessionState;
      /**
       * Captures kept per pane for the history scrubber.
       *
       * The newest capture is always kept regardless: it is the value being
       * displayed, not history.
       */
      historyDepth: number;
    }
  | { type: "session"; session: SessionState }
  | { type: "panes"; panes: PaneSpec[] }
  | { type: "capture"; paneId: string; capture: ResolvedCapture }
  | { type: "captureError"; paneId: string; error: CaptureError }
  | { type: "busy"; paneId: string; busy: boolean };
