import type {
  CaptureError,
  Descriptor,
  PaneSpec,
  ResolvedCapture,
  SessionState,
} from "@python-debug-visualizer/protocol";
import { useEffect, useMemo, useState } from "preact/hooks";
import { type DecodedCapture, decodeChannels } from "../decode";
import type { CaptureSide } from "../diff";
import { availableViz, resolveViz } from "../viz";
import { Heatmap } from "../viz/Heatmap";
import { LinePlot } from "../viz/LinePlot";
import { post } from "../vscode";
import { HistoryBar } from "./HistoryBar";
import { OptionsBar } from "./OptionsBar";
import { StatsStrip } from "./StatsStrip";

interface Props {
  pane: PaneSpec;
  capture: ResolvedCapture | undefined;
  /** Past captures for this pane, newest first. */
  history: ResolvedCapture[];
  /** How far back the shown capture is; 0 is the newest. */
  offset: number;
  pinned: ResolvedCapture | undefined;
  session: SessionState;
  error: CaptureError | undefined;
  busy: boolean;
  onSeek(offset: number): void;
  onPin(): void;
  onUnpin(): void;
}

export function Pane({
  pane,
  capture,
  history,
  offset,
  pinned,
  session,
  error,
  busy,
  onSeek,
  onPin,
  onUnpin,
}: Props) {
  const decoded = useMemo(
    () => (capture ? decodeChannels(capture.descriptor, capture.bytes) : undefined),
    [capture],
  );

  const pinnedSide = useMemo(
    () =>
      pinned
        ? {
            descriptor: pinned.descriptor,
            decoded: decodeChannels(pinned.descriptor, pinned.bytes),
          }
        : undefined,
    [pinned],
  );

  // After the expression is edited, the plot on screen still describes the old
  // one until the next evaluation lands. It stays visible — clearing it would
  // flicker on every debugger step — but it is dimmed, so it never reads as an
  // answer to the expression now in the header.
  const stale = capture !== undefined && capture.expression !== pane.expression;

  const activeViz = capture ? resolveViz(capture.descriptor, pane.viz)?.kind : undefined;

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
      {capture && activeViz && (
        <OptionsBar pane={pane} descriptor={capture.descriptor} viz={activeViz} />
      )}

      <div className={busy || stale ? "pane-body busy" : "pane-body"}>
        {error && <ErrorCard error={error} paneId={pane.id} />}

        {!error && !capture && <p className="empty-state">{whyNothingYet(session)}</p>}

        {capture && decoded && (
          <VizBody
            pane={pane}
            descriptor={capture.descriptor}
            decoded={decoded}
            reference={pinnedSide}
          />
        )}

        {capture && decoded && (
          <HistoryBar
            history={history}
            offset={offset}
            pinned={pinned}
            viewing={{ descriptor: capture.descriptor, decoded }}
            pinnedSide={pinnedSide}
            onSeek={onSeek}
            onPin={onPin}
            onUnpin={onUnpin}
          />
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
 * Why this pane is empty.
 *
 * "Nothing here" has several unrelated causes, and a single message for all of
 * them turns a two-second fix into a bug report. The session state is the
 * discriminator, so it is what gets said.
 */
function whyNothingYet(session: SessionState): string {
  switch (session.status) {
    case "no-session":
      return "No debug session yet. Start one and pause to evaluate this expression.";
    case "unsupported":
      return `This extension evaluates Python expressions, and the active session is "${session.sessionType}".`;
    case "running":
      return "The debugger is running. This will be evaluated the next time it stops.";
    case "stopped":
      return session.runtimeError
        ? `The visualizer runtime could not be installed: ${session.runtimeError}`
        : "Evaluating…";
  }
}

/** Renders whichever visualization the descriptor and the user's choice select. */
function VizBody({
  pane,
  descriptor,
  decoded,
  reference,
}: {
  pane: PaneSpec;
  descriptor: Descriptor;
  decoded: DecodedCapture;
  reference: CaptureSide | undefined;
}) {
  const definition = resolveViz(descriptor, pane.viz);
  if (!definition) {
    return <pre className="object-preview">{descriptor.preview}</pre>;
  }

  // Line and scatter are driven directly rather than through the registry's
  // component, because they take options the generic interface does not carry:
  // log scales, an overlaid reference, and the zoom callback.
  if (definition.kind === "line" || definition.kind === "scatter") {
    return (
      <LinePlot
        descriptor={descriptor}
        decoded={decoded}
        mode={definition.kind === "scatter" ? "scatter" : "line"}
        reference={reference}
        logX={pane.options.logX === true}
        logY={pane.options.logY === true}
        onZoom={(range) => post({ type: "zoom", paneId: pane.id, range })}
      />
    );
  }

  if (definition.kind === "heatmap") {
    return <Heatmap descriptor={descriptor} decoded={decoded} colormap={pane.options.colormap} />;
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
