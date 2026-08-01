import type { Descriptor } from "@python-debug-visualizer/protocol";

/**
 * The always-visible summary of a captured value.
 *
 * Every number here describes the *whole* value, including the parts the plot
 * below does not show. That is the guarantee that makes the strip worth
 * trusting: when the runtime downsamples 200 000 points to 2 000, the max shown
 * here is still the real max, spike included.
 */
export function StatsStrip({ descriptor }: { descriptor: Descriptor }) {
  const { stats, decimation } = descriptor;

  return (
    <div className="stats-strip">
      <Stat label="type" value={shortType(descriptor.pythonType)} />
      {descriptor.shape && <Stat label="shape" value={`(${descriptor.shape.join(", ")})`} />}
      {descriptor.dtype && <Stat label="dtype" value={descriptor.dtype} />}
      {descriptor.nbytes !== null && <Stat label="size" value={formatBytes(descriptor.nbytes)} />}

      {stats && (
        <>
          <Stat label="min" value={formatNumber(stats.min)} />
          <Stat label="max" value={formatNumber(stats.max)} />
          <Stat label="mean" value={formatNumber(stats.mean)} />
          <Stat label="std" value={formatNumber(stats.std)} />
          {stats.nanCount > 0 && <Stat label="NaN" value={stats.nanCount.toLocaleString()} alert />}
          {stats.infCount > 0 && <Stat label="Inf" value={stats.infCount.toLocaleString()} alert />}
        </>
      )}

      {decimation && (
        <Stat
          label="shown"
          value={`${decimation.outputLength.toLocaleString()} of ${decimation.originalLength.toLocaleString()} (${decimation.method})`}
          alert
        />
      )}
    </div>
  );
}

function Stat({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <span className={alert ? "stat alert" : "stat"}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </span>
  );
}

/** `numpy.ndarray` reads better than the fully qualified pandas paths. */
function shortType(pythonType: string): string {
  const parts = pythonType.split(".");
  if (parts.length <= 2) return pythonType;
  return `${parts[0]}.${parts[parts.length - 1]}`;
}

export function formatNumber(value: number | null): string {
  if (value === null) return "—";
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return value.toLocaleString();

  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude < 1e-4 || magnitude >= 1e7)) {
    return value.toExponential(3);
  }
  return trimZeros(value.toPrecision(6));
}

function trimZeros(text: string): string {
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}
