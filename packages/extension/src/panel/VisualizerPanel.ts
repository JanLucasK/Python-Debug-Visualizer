import { randomBytes } from "node:crypto";
import type {
  ExtensionToWebview,
  PaneSpec,
  WebviewToExtension,
} from "@python-debug-visualizer/protocol";
import * as vscode from "vscode";
import { CaptureFailure, type CaptureService } from "../debug/CaptureService";
import type { SessionTracker } from "../debug/SessionTracker";
import { log } from "../log";
import { PaneStore } from "./PaneStore";

const VIEW_TYPE = "pythonDebugPlots.panel";

export class VisualizerPanel implements vscode.Disposable {
  private static current: VisualizerPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly store: PaneStore;
  private readonly sequences = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private webviewReady = false;

  static show(
    context: vscode.ExtensionContext,
    tracker: SessionTracker,
    captures: CaptureService,
  ): VisualizerPanel {
    if (VisualizerPanel.current) {
      VisualizerPanel.current.panel.reveal(undefined, true);
      return VisualizerPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      "Debug Plots",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        // A debugging tool must not lose its plots when you switch tabs to look
        // at the code the plot is about.
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist", "webview")],
      },
    );

    VisualizerPanel.current = new VisualizerPanel(panel, context, tracker, captures);
    return VisualizerPanel.current;
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly tracker: SessionTracker,
    private readonly captures: CaptureService,
  ) {
    this.store = new PaneStore(context.workspaceState);
    this.panel.webview.html = this.render();

    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((message: WebviewToExtension) =>
        this.handle(message).catch((error) => log.error("Message handling failed", error)),
      ),
      this.tracker.onDidChange(() => this.onSessionChanged()),
    );
  }

  /** Adds an expression and evaluates it immediately. */
  addExpression(expression: string): void {
    const pane = this.store.add(expression);
    this.post({ type: "panes", panes: this.store.list() });
    void this.refresh(pane);
  }

  private async handle(message: WebviewToExtension): Promise<void> {
    switch (message.type) {
      case "ready":
        this.webviewReady = true;
        this.post({
          type: "init",
          panes: this.store.list(),
          session: this.tracker.state,
          historyDepth: vscode.workspace
            .getConfiguration("pythonDebugPlots")
            .get<number>("historyDepth", 20),
        });
        await this.refreshAll();
        break;
      case "addPane":
        this.addExpression(message.expression);
        break;
      case "updatePane": {
        const before = this.store.update(message.pane);
        this.post({ type: "panes", panes: this.store.list() });

        // A different expression, a different visualization or different
        // options are all new questions, and are answered even for a frozen
        // pane -- otherwise freezing would silently swallow the change. Some
        // visualizations are reductions Python computes, so the choice has to
        // reach it. Merely toggling `frozen` is not a new question and must not
        // re-evaluate: that is the whole point of freezing.
        const asksSomethingNew =
          before !== undefined &&
          (before.expression !== message.pane.expression ||
            before.viz !== message.pane.viz ||
            JSON.stringify(before.options) !== JSON.stringify(message.pane.options));
        await this.refresh(message.pane, { force: asksSomethingNew });
        break;
      }
      case "removePane":
        this.store.remove(message.paneId);
        this.sequences.delete(message.paneId);
        this.post({ type: "panes", panes: this.store.list() });
        break;
      case "refresh": {
        const panes = message.paneId
          ? this.store.list().filter((pane) => pane.id === message.paneId)
          : this.store.list();
        await Promise.all(panes.map((pane) => this.refresh(pane, { force: true })));
        break;
      }
      case "zoom": {
        const pane = this.store.list().find((candidate) => candidate.id === message.paneId);
        if (!pane) break;

        // Stored on the pane rather than held aside, so the zoom survives the
        // next debugger step -- otherwise stepping while zoomed in would throw
        // the user back out to the full range on every stop.
        const zoomed: PaneSpec = {
          ...pane,
          options: { ...pane.options, range: message.range ?? undefined },
        };
        this.store.update(zoomed);
        await this.refresh(zoomed, { force: true });
        break;
      }
      case "log":
        log.debug(`webview: ${message.text}`);
        break;
      case "revealTraceback":
        log.show();
        break;
    }
  }

  private onSessionChanged(): void {
    this.post({ type: "session", session: this.tracker.state });
    const autoRefresh = vscode.workspace
      .getConfiguration("pythonDebugPlots")
      .get<boolean>("autoRefresh", true);
    if (autoRefresh && this.tracker.context) {
      void this.refreshAll();
    }
  }

  private async refreshAll(): Promise<void> {
    await Promise.all(this.store.list().map((pane) => this.refresh(pane)));
  }

  private async refresh(pane: PaneSpec, { force = false } = {}): Promise<void> {
    if (!this.webviewReady) return;
    if (pane.frozen && !force) return;

    // Stepping quickly can outpace evaluation. Dropping the overlapping request
    // is right: the debuggee has already moved on, so its answer would describe
    // a state the user has left.
    if (this.inFlight.has(pane.id)) return;
    this.inFlight.add(pane.id);
    this.post({ type: "busy", paneId: pane.id, busy: true });

    try {
      const sequence = (this.sequences.get(pane.id) ?? 0) + 1;
      this.sequences.set(pane.id, sequence);

      const capture = await this.captures.capture({
        expression: pane.expression,
        viz: pane.viz,
        options: {
          maxPoints: vscode.workspace
            .getConfiguration("pythonDebugPlots")
            .get<number>("maxPoints", 20000),
          ...pane.options,
        },
        sequence,
      });
      this.post({ type: "capture", paneId: pane.id, capture });
    } catch (error) {
      this.post({
        type: "captureError",
        paneId: pane.id,
        error:
          error instanceof CaptureFailure
            ? error.detail
            : {
                type: "InternalError",
                message: error instanceof Error ? error.message : String(error),
                traceback: null,
              },
      });
    } finally {
      this.inFlight.delete(pane.id);
      this.post({ type: "busy", paneId: pane.id, busy: false });
    }
  }

  private post(message: ExtensionToWebview): void {
    void this.panel.webview.postMessage(message);
  }

  private render(): string {
    const { webview } = this.panel;
    const root = vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(root, "main.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(root, "main.css"));
    const nonce = randomBytes(16).toString("base64");

    // `style-src 'unsafe-inline'` is required because uPlot positions its
    // canvas layers through element style attributes. Scripts stay locked to
    // the nonce, so no injected markup can execute.
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${style}" />
    <title>Debug Plots</title>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${script}"></script>
  </body>
</html>`;
  }

  dispose(): void {
    VisualizerPanel.current = undefined;
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
    this.panel.dispose();
  }
}
