import type { CaptureError, PaneSpec, ResolvedCapture } from "@python-debug-visualizer/protocol";
import { useMemo } from "preact/hooks";
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

  return (
    <section className="pane">
      <header className="pane-header">
        <span className="pane-expression" title={pane.expression}>
          {pane.expression}
        </span>
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

      <div className={busy ? "pane-body busy" : "pane-body"}>
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
