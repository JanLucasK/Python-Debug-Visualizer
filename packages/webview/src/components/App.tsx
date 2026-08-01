import type {
  CaptureError,
  ExtensionToWebview,
  PaneSpec,
  ResolvedCapture,
  SessionState,
} from "@python-debug-visualizer/protocol";
import { useEffect, useRef, useState } from "preact/hooks";
import { onMessage, post } from "../vscode";
import { Pane } from "./Pane";

const INITIAL_SESSION: SessionState = {
  status: "no-session",
  sessionType: null,
  runtimeReady: false,
  runtimeError: null,
};

export function App() {
  const [panes, setPanes] = useState<PaneSpec[]>([]);
  const [session, setSession] = useState<SessionState>(INITIAL_SESSION);
  const [errors, setErrors] = useState<Record<string, CaptureError>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  /** Past captures per pane, newest first. */
  const [history, setHistory] = useState<Record<string, ResolvedCapture[]>>({});
  /** How far back each pane is currently showing; 0 is the newest capture. */
  const [offsets, setOffsets] = useState<Record<string, number>>({});
  const [pinned, setPinned] = useState<Record<string, ResolvedCapture>>({});
  const [depth, setDepth] = useState(20);

  // Mirrors `panes` so the message handler can diff against the previous list
  // without depending on it, which would re-subscribe on every change.
  const previousPanes = useRef<PaneSpec[]>([]);
  // Same reasoning for the history depth: the message subscription is set up
  // once, and re-subscribing whenever a setting changed would drop messages.
  const depthRef = useRef(depth);
  depthRef.current = depth;

  useEffect(() => {
    /**
     * An error card describes a specific expression. Once that expression is
     * edited the card no longer applies to anything on screen, so it goes --
     * unlike the plot, which is merely dimmed until the next capture replaces
     * it.
     */
    const adoptPanes = (next: PaneSpec[]) => {
      const rewritten = next.filter((pane) => {
        const before = previousPanes.current.find((candidate) => candidate.id === pane.id);
        return before !== undefined && before.expression !== pane.expression;
      });
      previousPanes.current = next;
      setPanes(next);
      if (rewritten.length > 0) {
        setErrors((existing) => rewritten.reduce((acc, pane) => omit(acc, pane.id), existing));
        // History belongs to an expression. Keeping it across an edit would
        // offer to diff two different questions against each other.
        setHistory((existing) => rewritten.reduce((acc, pane) => omit(acc, pane.id), existing));
        setPinned((existing) => rewritten.reduce((acc, pane) => omit(acc, pane.id), existing));
        setOffsets((existing) => rewritten.reduce((acc, pane) => omit(acc, pane.id), existing));
      }
    };

    /**
     * Push a capture onto a pane's history.
     *
     * If the user has scrubbed back, the offset moves with them so they stay on
     * the capture they were looking at. Snapping to the newest one would yank
     * the view away every time the debugger stops, which is exactly when
     * somebody is trying to hold still and compare.
     */
    const recordCapture = (paneId: string, capture: ResolvedCapture) => {
      setHistory((current) => {
        const kept = [capture, ...(current[paneId] ?? [])].slice(0, depthRef.current);
        return { ...current, [paneId]: kept };
      });
      setOffsets((current) => {
        const offset = current[paneId] ?? 0;
        if (offset === 0) return current;
        return { ...current, [paneId]: Math.min(offset + 1, depthRef.current - 1) };
      });
    };

    const stop = onMessage((message: ExtensionToWebview) => {
      switch (message.type) {
        case "init":
          adoptPanes(message.panes);
          setSession(message.session);
          setDepth(Math.max(1, message.historyDepth));
          break;
        case "panes":
          adoptPanes(message.panes);
          break;
        case "session":
          setSession(message.session);
          break;
        case "capture":
          recordCapture(message.paneId, message.capture);
          // A successful capture clears the previous failure; leaving a stale
          // error card above fresh data would be actively misleading.
          setErrors((current) => omit(current, message.paneId));
          break;
        case "captureError":
          setErrors((current) => ({ ...current, [message.paneId]: message.error }));
          break;
        case "busy":
          setBusy((current) => ({ ...current, [message.paneId]: message.busy }));
          break;
      }
    });

    post({ type: "ready" });
    return stop;
  }, []);

  return (
    <>
      <ExpressionBar />
      <SessionBanner session={session} />
      <div className="panes">
        {panes.length === 0 && <EmptyState />}
        {panes.map((pane) => {
          const kept = history[pane.id] ?? [];
          const offset = Math.min(offsets[pane.id] ?? 0, Math.max(0, kept.length - 1));
          return (
            <Pane
              key={pane.id}
              pane={pane}
              capture={kept[offset]}
              history={kept}
              offset={offset}
              pinned={pinned[pane.id]}
              error={errors[pane.id]}
              busy={busy[pane.id] === true}
              onSeek={(next) =>
                setOffsets((current) => ({
                  ...current,
                  [pane.id]: Math.max(0, Math.min(next, kept.length - 1)),
                }))
              }
              onPin={() => {
                const capture = kept[offset];
                if (capture) setPinned((current) => ({ ...current, [pane.id]: capture }));
              }}
              onUnpin={() => setPinned((current) => omit(current, pane.id))}
            />
          );
        })}
      </div>
    </>
  );
}

function ExpressionBar() {
  const [draft, setDraft] = useState("");

  const submit = () => {
    const expression = draft.trim();
    if (!expression) return;
    post({ type: "addPane", expression });
    setDraft("");
  };

  return (
    <div className="expression-bar">
      <input
        type="text"
        value={draft}
        placeholder="Python expression, e.g. prices[-500:] or df['close'].values"
        spellcheck={false}
        onInput={(event) => setDraft((event.target as HTMLInputElement).value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
        }}
      />
      <button type="button" onClick={submit}>
        Add
      </button>
      <button type="button" className="secondary" onClick={() => post({ type: "refresh" })}>
        Refresh all
      </button>
    </div>
  );
}

/**
 * Explains why nothing is happening, when nothing is happening.
 *
 * "No plot appeared" has several very different causes — no session, a running
 * session, the wrong debugger, a failed injection — and guessing between them
 * is the most annoying part of using a tool like this.
 */
function SessionBanner({ session }: { session: SessionState }) {
  const message = describeSession(session);
  if (!message) return null;
  return <div className="session-banner">{message}</div>;
}

function describeSession(session: SessionState): string | null {
  switch (session.status) {
    case "no-session":
      return "No debug session. Start one and pause to evaluate expressions.";
    case "unsupported":
      return `The active debug session is "${session.sessionType}". This extension supports Python (debugpy).`;
    case "running":
      return "Running. Expressions are evaluated whenever the debugger stops.";
    case "stopped":
      return session.runtimeError ? `Runtime unavailable: ${session.runtimeError}` : null;
  }
}

function EmptyState() {
  return (
    <div className="empty-state">
      <p>Add an expression above to plot it.</p>
      <p>
        You can also select one in the editor and press <code>Ctrl+Alt+V</code>, or right-click a
        variable in the Variables view.
      </p>
    </div>
  );
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}
