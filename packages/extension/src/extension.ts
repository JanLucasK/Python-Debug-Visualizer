import * as vscode from "vscode";
import { Bootstrapper } from "./debug/Bootstrapper";
import { CaptureService } from "./debug/CaptureService";
import { SessionTracker } from "./debug/SessionTracker";
import { initLogging, log } from "./log";
import { VisualizerPanel } from "./panel/VisualizerPanel";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(initLogging());

  const tracker = new SessionTracker();
  const bootstrapper = new Bootstrapper();
  const captures = new CaptureService(tracker, bootstrapper);
  context.subscriptions.push(tracker);

  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession((session) => bootstrapper.forget(session.id)),
  );

  const open = () => VisualizerPanel.show(context, tracker, captures);

  context.subscriptions.push(
    vscode.commands.registerCommand("pythonDebugVisualizer.open", open),

    vscode.commands.registerCommand("pythonDebugVisualizer.refresh", () => {
      open();
      void vscode.commands.executeCommand("workbench.action.webview.reloadWebviewAction");
    }),

    vscode.commands.registerCommand("pythonDebugVisualizer.visualizeSelection", () => {
      const expression = selectedExpression();
      if (!expression) {
        void vscode.window.showInformationMessage(
          "Select a Python expression to visualize, or open the visualizer and type one.",
        );
        return;
      }
      open().addExpression(expression);
    }),

    vscode.commands.registerCommand("pythonDebugVisualizer.visualizeVariable", (item: unknown) => {
      const expression = variableExpression(item);
      if (!expression) {
        void vscode.window.showInformationMessage("That variable cannot be re-evaluated by name.");
        return;
      }
      open().addExpression(expression);
    }),
  );

  log.info("Python Debug Visualizer activated");
}

export function deactivate(): void {
  // Everything is registered through context.subscriptions.
}

/**
 * The selected text, or the identifier under the cursor when nothing is
 * selected — pressing the shortcut with the caret inside a name should just
 * work rather than telling the user to select it first.
 */
function selectedExpression(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;

  if (!editor.selection.isEmpty) {
    const text = editor.document.getText(editor.selection).trim();
    return text.length > 0 ? text : undefined;
  }

  const range = editor.document.getWordRangeAtPosition(
    editor.selection.active,
    // Dotted and subscripted paths, so `df.close` and `data["x"]` come through whole.
    /[A-Za-z_][A-Za-z0-9_.]*(\[[^\]]*\])?/,
  );
  return range ? editor.document.getText(range) : undefined;
}

/**
 * Recover an expression from a Variables view entry.
 *
 * `evaluateName` is what the debug adapter says can be evaluated to get this
 * value back — for a nested item that is the full path, not just the leaf name.
 * Without it there is no reliable expression, so we decline rather than
 * evaluating a bare name that would resolve to something else entirely.
 */
function variableExpression(item: unknown): string | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const variable = (item as { variable?: { evaluateName?: string; name?: string } }).variable;
  const name = variable?.evaluateName;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}
