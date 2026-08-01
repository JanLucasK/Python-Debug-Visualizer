import type {
  CaptureError,
  ExtensionToWebview,
  PaneSpec,
  ResolvedCapture,
  SessionState,
} from "@python-debug-visualizer/protocol";
import { useEffect, useState } from "preact/hooks";
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
  const [captures, setCaptures] = useState<Record<string, ResolvedCapture>>({});
  const [errors, setErrors] = useState<Record<string, CaptureError>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const stop = onMessage((message: ExtensionToWebview) => {
      switch (message.type) {
        case "init":
          setPanes(message.panes);
          setSession(message.session);
          break;
        case "panes":
          setPanes(message.panes);
          break;
        case "session":
          setSession(message.session);
          break;
        case "capture":
          setCaptures((current) => ({ ...current, [message.paneId]: message.capture }));
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
        {panes.map((pane) => (
          <Pane
            key={pane.id}
            pane={pane}
            capture={captures[pane.id]}
            error={errors[pane.id]}
            busy={busy[pane.id] === true}
          />
        ))}
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
