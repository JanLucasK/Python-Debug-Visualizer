import type {
  CaptureError,
  Descriptor,
  PaneSpec,
  ResolvedCapture,
} from "@python-debug-visualizer/protocol";
import { useEffect, useMemo, useState } from "preact/hooks";
import { type DecodedCapture, decodeChannels } from "../decode";
import { availableViz, resolveViz } from "../viz";
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
        {capture && <VizSelector pane={pane} descriptor={capture.descriptor} />}
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

        {capture && decoded && (
          <VizBody descriptor={capture.descriptor} decoded={decoded} viz={pane.viz} />
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

/** Renders whichever visualization the descriptor and the user's choice select. */
function VizBody({
  descriptor,
  decoded,
  viz,
}: { descriptor: Descriptor; decoded: DecodedCapture; viz: PaneSpec["viz"] }) {
  const definition = resolveViz(descriptor, viz);
  if (!definition) {
    return <pre className="object-preview">{descriptor.preview}</pre>;
  }
  const Component = definition.component;
  return <Component descriptor={descriptor} decoded={decoded} />;
}

/**
 * Choice of visualization for this pane.
 *
 * Only the kinds that suit the value are offered, judged from its shape and
 * type rather than from the channels the current capture happens to carry --
 * otherwise switching to a histogram, which asks Python for bins instead of
 * points, would remove every other option and strand the user there.
 */
function VizSelector({ pane, descriptor }: { pane: PaneSpec; descriptor: Descriptor }) {
  const options = availableViz(descriptor);
  if (options.length < 2) return null;

  const active = resolveViz(descriptor, pane.viz);

  return (
    <select
      className="viz-option"
      aria-label="Visualization"
      value={pane.viz === "auto" ? "auto" : (active?.kind ?? "auto")}
      onChange={(event) => {
        const chosen = (event.target as HTMLSelectElement).value as PaneSpec["viz"];
        post({ type: "updatePane", pane: { ...pane, viz: chosen } });
      }}
    >
      <option value="auto">Auto{active ? ` (${active.label})` : ""}</option>
      {options.map((definition) => (
        <option key={definition.kind} value={definition.kind}>
          {definition.label}
        </option>
      ))}
    </select>
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
