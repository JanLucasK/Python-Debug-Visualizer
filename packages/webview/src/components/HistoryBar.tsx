import type { ResolvedCapture } from "@python-debug-visualizer/protocol";
import { useMemo } from "preact/hooks";
import { type CaptureSide, diffCaptures, totals } from "../diff";

interface Props {
  /** Newest first. */
  history: ResolvedCapture[];
  /** How far back the pane is currently showing; 0 is the newest capture. */
  offset: number;
  pinned: ResolvedCapture | undefined;
  viewing: CaptureSide;
  pinnedSide: CaptureSide | undefined;
  onSeek(offset: number): void;
  onPin(): void;
  onUnpin(): void;
}

/**
 * Stepping back through past captures, and comparing against a pinned one.
 *
 * This is the reason the project exists. Watching a value change as you step is
 * useful; being able to hold one step still and ask *what moved* is the thing
 * no other tool in this space does.
 */
export function HistoryBar({
  history,
  offset,
  pinned,
  viewing,
  pinnedSide,
  onSeek,
  onPin,
  onUnpin,
}: Props) {
  const summary = useMemo(
    () => (pinnedSide ? diffCaptures(viewing, pinnedSide) : undefined),
    [viewing, pinnedSide],
  );

  if (history.length < 2 && !pinned) return null;

  const current = history[offset];
  const atNewest = offset === 0;

  return (
    <div className="history-bar">
      <button
        type="button"
        className="icon-button"
        title="Older capture"
        disabled={offset >= history.length - 1}
        onClick={() => onSeek(offset + 1)}
      >
        ◀
      </button>
      <button
        type="button"
        className="icon-button"
        title="Newer capture"
        disabled={atNewest}
        onClick={() => onSeek(offset - 1)}
      >
        ▶
      </button>

      <span className={atNewest ? "history-position" : "history-position history-past"}>
        {atNewest ? "latest" : `${offset} step${offset === 1 ? "" : "s"} back`}
        {current && <> · {new Date(current.capturedAt).toLocaleTimeString()}</>}
        {" · "}
        {history.length} kept
      </span>

      {pinned ? (
        <button type="button" className="icon-button" title="Stop comparing" onClick={onUnpin}>
          unpin
        </button>
      ) : (
        <button
          type="button"
          className="icon-button"
          title="Compare later captures against this one"
          onClick={onPin}
        >
          pin
        </button>
      )}

      {summary && <DiffChip summary={summary} />}
    </div>
  );
}

function DiffChip({ summary }: { summary: ReturnType<typeof diffCaptures> }) {
  if (summary.incomparable) {
    return <span className="diff-chip diff-alert">{summary.incomparable}</span>;
  }

  const { comparable, changed, maxAbsDelta } = totals(summary);

  return (
    <span className={changed > 0 ? "diff-chip diff-alert" : "diff-chip"}>
      {summary.shapeChanged && <>shape changed from ({summary.previousShape?.join(", ")}) · </>}
      {changed.toLocaleString()} of {comparable.toLocaleString()} changed
      {changed > 0 && <> · max |Δ| {formatDelta(maxAbsDelta)}</>}
      {/* Points with no counterpart are called out rather than folded into
          "unchanged", which would understate what moved. */}
      {summary.unmatched > 0 && <> · {summary.unmatched.toLocaleString()} unmatched</>}
    </span>
  );
}

function formatDelta(value: number): string {
  if (value === 0) return "0";
  const magnitude = Math.abs(value);
  if (magnitude < 1e-4 || magnitude >= 1e6) return value.toExponential(2);
  return Number(value.toPrecision(4)).toString();
}
