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

  update(pane: PaneSpec): void {
    this.panes = this.panes.map((existing) => (existing.id === pane.id ? pane : existing));
    void this.persist();
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
    panes.push({
      id: candidate.id,
      expression: candidate.expression,
      viz: candidate.viz ?? "auto",
      options: typeof candidate.options === "object" && candidate.options ? candidate.options : {},
      frozen: candidate.frozen === true,
    });
  }
  return panes;
}
