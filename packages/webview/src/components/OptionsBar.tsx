import type { Descriptor, PaneSpec, VizKind, VizOptions } from "@python-debug-visualizer/protocol";
import { useEffect, useState } from "preact/hooks";
import { COLORMAP_NAMES } from "../viz/colormaps";
import { post } from "../vscode";

interface Props {
  pane: PaneSpec;
  descriptor: Descriptor;
  viz: VizKind;
}

/**
 * Per-pane settings, shown only where they apply.
 *
 * These live on the pane rather than in workspace settings because they are
 * properties of one question, not of the workspace: the bin count that suits a
 * distribution of latencies is not the one that suits a distribution of prices,
 * and having to change a global setting between the two would make comparing
 * them tedious enough that nobody would.
 */
export function OptionsBar({ pane, descriptor, viz }: Props) {
  const update = (options: Partial<VizOptions>) =>
    post({ type: "updatePane", pane: { ...pane, options: { ...pane.options, ...options } } });

  const showsAxes = viz === "line" || viz === "scatter";
  const showsBins = viz === "histogram";
  const showsColormap = viz === "heatmap";

  return (
    <div className="options-bar">
      {showsAxes && <AxisField pane={pane} onCommit={(xSource) => update({ xSource })} />}

      {showsAxes && (
        <label className="option-toggle">
          <input
            type="checkbox"
            checked={pane.options.logY === true}
            onChange={(event) => update({ logY: (event.target as HTMLInputElement).checked })}
          />
          log y
        </label>
      )}

      {showsBins && (
        <label className="option-field">
          bins
          <input
            type="number"
            min={1}
            max={512}
            placeholder="auto"
            value={pane.options.bins ?? ""}
            onChange={(event) => {
              const raw = (event.target as HTMLInputElement).value;
              update({ bins: raw === "" ? undefined : Number(raw) });
            }}
          />
        </label>
      )}

      {showsColormap && (
        <label className="option-field">
          colours
          <select
            value={pane.options.colormap ?? ""}
            onChange={(event) => {
              const value = (event.target as HTMLSelectElement).value;
              update({ colormap: value === "" ? undefined : value });
            }}
          >
            <option value="">auto</option>
            {COLORMAP_NAMES.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="option-field">
        max points
        <input
          type="number"
          min={100}
          step={1000}
          placeholder="default"
          value={pane.options.maxPoints ?? ""}
          onChange={(event) => {
            const raw = (event.target as HTMLInputElement).value;
            update({ maxPoints: raw === "" ? undefined : Number(raw) });
          }}
        />
      </label>

      {/* A zoom is a state you can forget you are in, and every reading after
          it describes only part of the data. It gets its own way out. */}
      {pane.options.range && (
        <button
          type="button"
          className="icon-button option-reset"
          title="Show the whole range again"
          onClick={() => post({ type: "zoom", paneId: pane.id, range: null })}
        >
          reset zoom
        </button>
      )}

      {descriptor.truncated && <span className="option-note">partial</span>}
    </div>
  );
}

/**
 * The x axis, as a Python expression.
 *
 * A free-text field rather than a list of column names, because the useful
 * answer is frequently not a column: `np.arange(len(y)) * dt`, `df.index.hour`,
 * or another variable entirely.
 */
function AxisField({ pane, onCommit }: { pane: PaneSpec; onCommit(value: string): void }) {
  const [draft, setDraft] = useState(pane.options.xSource ?? "");
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(pane.options.xSource ?? "");
  }, [pane.options.xSource, editing]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next !== (pane.options.xSource ?? "")) onCommit(next === "" ? "index" : next);
  };

  return (
    <label className="option-field option-axis">
      x
      <input
        type="text"
        placeholder="index"
        spellcheck={false}
        value={draft === "index" ? "" : draft}
        onFocus={() => setEditing(true)}
        onInput={(event) => setDraft((event.target as HTMLInputElement).value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
          if (event.key === "Escape") {
            setDraft(pane.options.xSource ?? "");
            setEditing(false);
            (event.target as HTMLInputElement).blur();
          }
        }}
      />
    </label>
  );
}
