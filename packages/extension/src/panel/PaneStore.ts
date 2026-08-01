import { randomUUID } from "node:crypto";
import type { PaneSpec } from "@python-debug-visualizer/protocol";
import type * as vscode from "vscode";

const STORAGE_KEY = "pythonDebugVisualizer.panes";

/**
 * The list of expressions being watched, persisted per workspace.
 *
 * Expressions survive across sessions on purpose. Debugging the same algorithm
 * over successive runs is the normal case, and retyping `df["close"].values`
 * every time would be the tool's most-repeated annoyance.
 */
export class PaneStore {
  private panes: PaneSpec[];

  constructor(private readonly memento: vscode.Memento) {
    this.panes = sanitize(memento.get<unknown>(STORAGE_KEY));
  }

  list(): PaneSpec[] {
    return this.panes;
  }

  add(expression: string): PaneSpec {
    const pane: PaneSpec = {
      id: randomUUID(),
      expression,
      viz: "auto",
      options: {},
      frozen: false,
    };
    this.panes = [...this.panes, pane];
    void this.persist();
    return pane;
  }

  /** Applies the change and returns the pane as it was, so callers can diff. */
  update(pane: PaneSpec): PaneSpec | undefined {
    const before = this.panes.find((existing) => existing.id === pane.id);
    this.panes = this.panes.map((existing) => (existing.id === pane.id ? pane : existing));
    void this.persist();
    return before;
  }

  remove(paneId: string): void {
    this.panes = this.panes.filter((pane) => pane.id !== paneId);
    void this.persist();
  }

  private persist(): Thenable<void> {
    return this.memento.update(STORAGE_KEY, this.panes);
  }
}

/**
 * Persisted state is effectively untrusted input: it may have been written by
 * an older version with a different shape. Anything unrecognisable is dropped
 * rather than allowed to crash activation.
 */
function sanitize(stored: unknown): PaneSpec[] {
  if (!Array.isArray(stored)) return [];
  const panes: PaneSpec[] = [];
  for (const entry of stored) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as Partial<PaneSpec>;
    if (typeof candidate.id !== "string" || typeof candidate.expression !== "string") continue;
    const options =
      typeof candidate.options === "object" && candidate.options ? { ...candidate.options } : {};
    // A zoom is a view of one moment, not a property of the expression. Keeping
    // it across sessions would reopen the pane showing a slice of data that no
    // longer exists, with no hint as to why.
    options.range = undefined;

    panes.push({
      id: candidate.id,
      expression: candidate.expression,
      viz: candidate.viz ?? "auto",
      options,
      frozen: candidate.frozen === true,
    });
  }
  return panes;
}
