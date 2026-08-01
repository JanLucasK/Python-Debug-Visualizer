import type { CaptureError, PaneSpec, ResolvedCapture } from "@python-debug-visualizer/protocol";
import { useEffect, useMemo, useState } from "preact/hooks";
import { decodeChannels } from "../decode";
import { LinePlot } from "../viz/LinePlot";
import { post } from "../vscode";
import { StatsStrip } from "./StatsStrip";

interface Props {
  pane: PaneSpec;
  capture: ResolvedCapture | undefined;
  error: CaptureError | undefined;
  busy: boolean;
}

export function Pane({ pane, capture, error, busy }: Props) {
  const decoded = useMemo(
    () => (capture ? decodeChannels(capture.descriptor, capture.bytes) : undefined),
    [capture],
  );

  // After the expression is edited, the plot on screen still describes the old
  // one until the next evaluation lands. It stays visible — clearing it would
  // flicker on every debugger step — but it is dimmed, so it never reads as an
  // answer to the expression now in the header.
  const stale = capture !== undefined && capture.expression !== pane.expression;

  return (
    <section className="pane">
      <header className="pane-header">
        <ExpressionInput pane={pane} />
        <button
          type="button"
          className="icon-button"
          title={pane.frozen ? "Resume updating on each step" : "Freeze at the current value"}
          onClick={() => post({ type: "updatePane", pane: { ...pane, frozen: !pane.frozen } })}
        >
          {pane.frozen ? "frozen" : "live"}
        </button>
        <button
          type="button"
          className="icon-button"
          title="Re-evaluate now"
          onClick={() => post({ type: "refresh", paneId: pane.id })}
        >
          refresh
        </button>
        <button
          type="button"
          className="icon-button"
          title="Remove"
          onClick={() => post({ type: "removePane", paneId: pane.id })}
        >
          remove
        </button>
      </header>

      {capture && <StatsStrip descriptor={capture.descriptor} />}

      <div className={busy || stale ? "pane-body busy" : "pane-body"}>
        {error && <ErrorCard error={error} paneId={pane.id} />}

        {!error && !capture && <p className="empty-state">Waiting for the debugger to stop…</p>}

        {capture && decoded && capture.descriptor.channels.length > 0 && (
          <LinePlot descriptor={capture.descriptor} decoded={decoded} />
        )}

        {capture && capture.descriptor.channels.length === 0 && (
          <pre className="pane-preview">{capture.descriptor.preview}</pre>
        )}

        {/* Warnings from the runtime and from decoding are shown together --
            the user does not care which side of the wire noticed the problem. */}
        {[...(capture?.warnings ?? []), ...(decoded?.warnings ?? [])].map((warning) => (
          <p key={warning} className="notice warning">
            {warning}
          </p>
        ))}
      </div>
    </section>
  );
}

/**
 * The pane's expression, editable in place.
 *
 * Refining an expression is the normal way this tool gets used — you plot
 * `noisy`, then want `noisy[:200]`. Retyping it in the bar at the top would add
 * a second pane instead of changing this one, so the header is where the edit
 * belongs.
 */
function ExpressionInput({ pane }: { pane: PaneSpec }) {
  const [draft, setDraft] = useState(pane.expression);
  const [editing, setEditing] = useState(false);

  // Adopt outside changes only while not editing. Captures keep arriving as the
  // debugger steps, and a re-render must not overwrite half-typed input.
  useEffect(() => {
    if (!editing) setDraft(pane.expression);
  }, [pane.expression, editing]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (!next) {
      setDraft(pane.expression); // an empty expression would just error; treat it as a cancel
      return;
    }
    if (next !== pane.expression) {
      post({ type: "updatePane", pane: { ...pane, expression: next } });
    }
  };

  return (
    <input
      className="pane-expression"
      value={draft}
      title={pane.expression}
      spellcheck={false}
      aria-label="Expression"
      onFocus={() => setEditing(true)}
      onInput={(event) => setDraft((event.target as HTMLInputElement).value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          (event.target as HTMLInputElement).blur(); // blur commits
        } else if (event.key === "Escape") {
          setDraft(pane.expression);
          setEditing(false);
          (event.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function ErrorCard({ error, paneId }: { error: CaptureError; paneId: string }) {
  return (
    <div className="notice error">
      <strong>{error.type}</strong>: {error.message}
      {error.traceback && (
        <>
          <pre>{error.traceback}</pre>
          <button
            type="button"
            className="secondary"
            onClick={() => post({ type: "revealTraceback", paneId })}
          >
            Open log
          </button>
        </>
      )}
    </div>
  );
}
