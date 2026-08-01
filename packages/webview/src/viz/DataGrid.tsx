import type { Descriptor } from "@python-debug-visualizer/protocol";
import { useMemo, useState } from "preact/hooks";
import type { DecodedCapture } from "../decode";

interface Props {
  descriptor: Descriptor;
  decoded: DecodedCapture;
  height?: number;
}

const ROW_HEIGHT = 22;
/** Rows rendered beyond the viewport, so a flick of the wheel does not show blanks. */
const OVERSCAN = 8;
/** Columns rendered at all. Past this the table is not something anyone reads. */
const MAX_COLUMNS = 60;

/**
 * The numbers themselves, in a table.
 *
 * Virtualised because a 1000x1000 array is a million cells, and a debugger that
 * locks up for ten seconds while you look at an array is worse than one that
 * cannot show it. Only the visible rows exist in the DOM.
 */
export function DataGrid({ descriptor, decoded, height = 320 }: Props) {
  const [scrollTop, setScrollTop] = useState(0);
  const table = useMemo(() => collectTable(descriptor, decoded), [descriptor, decoded]);

  if (!table) {
    return <div className="notice warning">This capture has no values to tabulate.</div>;
  }

  const firstRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const lastRow = Math.min(table.rows, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);

  const visible = [];
  for (let row = firstRow; row < lastRow; row++) {
    visible.push(
      <tr key={row} style={{ height: ROW_HEIGHT }}>
        <th scope="row" className="grid-index">
          {table.rowLabel(row)}
        </th>
        {table.columns.map((column) => (
          <td key={column.key} className="grid-cell">
            {formatCell(table.valueAt(row, column))}
          </td>
        ))}
      </tr>,
    );
  }

  return (
    <div className="grid">
      {table.hiddenColumns > 0 && (
        <p className="notice warning">
          Showing the first {MAX_COLUMNS} of {table.columns.length + table.hiddenColumns} columns.
        </p>
      )}
      <div
        className="grid-scroll"
        style={{ height }}
        onScroll={(event) => setScrollTop((event.target as HTMLElement).scrollTop)}
      >
        <div style={{ height: table.rows * ROW_HEIGHT, position: "relative" }}>
          <table
            className="grid-table"
            style={{ position: "absolute", top: firstRow * ROW_HEIGHT, width: "100%" }}
          >
            <thead>
              <tr>
                <th className="grid-index" />
                {table.columns.map((column) => (
                  <th key={column.key} className="grid-heading" title={column.title}>
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>{visible}</tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

interface Column {
  key: string;
  label: string;
  title: string;
  /** Column position for a 2-D array, or the channel for a per-series table. */
  offset: number;
  values: Float64Array;
  stride: number;
}

interface Table {
  rows: number;
  columns: Column[];
  hiddenColumns: number;
  rowLabel(row: number): string;
  valueAt(row: number, column: Column): number | undefined;
}

export function collectTable(descriptor: Descriptor, decoded: DecodedCapture): Table | undefined {
  const shape = descriptor.shape;

  // A raw 2-D array is stored row-major in one channel, so a column is a
  // strided read rather than a channel of its own.
  //
  // Restricted to `ndarray`: a DataFrame also reports [rows, columns] but
  // carries one channel per column, named after it. Taking this branch for a
  // frame looked for a channel called "value", found none, and rendered "no
  // values to tabulate" for every DataFrame there is.
  if (descriptor.kind === "ndarray" && shape && shape.length === 2) {
    const channel = decoded.channels.get("value") ?? decoded.channels.get("y");
    if (!channel) return undefined;

    const [rows, cols] = shape as [number, number];
    const shown = Math.min(cols, MAX_COLUMNS);
    const columns: Column[] = Array.from({ length: shown }, (_, index) => ({
      key: String(index),
      label: String(index),
      title: `column ${index}`,
      offset: index,
      values: channel.values,
      stride: cols,
    }));

    return {
      rows,
      columns,
      hiddenColumns: cols - shown,
      rowLabel: (row) => String(row),
      valueAt: (row, column) => column.values[row * column.stride + column.offset],
    };
  }

  // Otherwise every value-bearing channel is its own column, which is what a
  // multi-series capture looks like.
  const series = descriptor.channels.filter((c) => c.role === "y" || c.role === "value");
  if (series.length === 0) return undefined;

  const shown = series.slice(0, MAX_COLUMNS);
  const columns: Column[] = [];
  for (const channel of shown) {
    const decodedChannel = decoded.channels.get(channel.name);
    if (!decodedChannel) continue;
    columns.push({
      key: channel.name,
      label: channel.name,
      title: `${channel.name} (${channel.dtype})`,
      offset: 0,
      values: decodedChannel.values,
      stride: 1,
    });
  }
  if (columns.length === 0) return undefined;

  const index = decoded.channels.get("x")?.values;
  const rows = Math.max(...columns.map((column) => column.values.length));
  const label = rowLabeller(descriptor, index);

  return {
    rows,
    columns,
    hiddenColumns: series.length - shown.length,
    rowLabel: label,
    valueAt: (row, column) => column.values[row],
  };
}

/**
 * How to label a row.
 *
 * With decimation the rows are a subset, so labels are the real index values
 * rather than 0..n-1 — otherwise the table would quietly renumber the data. A
 * datetime index is rendered as a date, because a column of epoch milliseconds
 * is technically correct and completely unreadable.
 */
function rowLabeller(
  descriptor: Descriptor,
  index: Float64Array | undefined,
): (row: number) => string {
  if (!index) return (row) => String(row);

  if (descriptor.index?.kind === "datetime" && descriptor.index.timeUnit === "ms") {
    return (row) => {
      const stamp = index[row];
      if (stamp === undefined || !Number.isFinite(stamp)) return String(row);
      return formatTimestamp(stamp);
    };
  }

  return (row) => String(index[row] ?? row);
}

function formatTimestamp(milliseconds: number): string {
  const when = new Date(milliseconds);
  const date = when.toISOString().slice(0, 10);
  const time = when.toISOString().slice(11, 19);
  // Midnight almost always means a date-only index, where a column of
  // "00:00:00" is pure noise.
  return time === "00:00:00" ? date : `${date} ${time}`;
}

function formatCell(value: number | undefined): string {
  if (value === undefined) return "";
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "Inf" : "-Inf";
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);

  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude < 1e-4 || magnitude >= 1e6)) return value.toExponential(3);
  return Number(value.toPrecision(6)).toString();
}
