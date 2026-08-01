import { z } from "zod";
import { wireDtypeSchema } from "./dtype";

/** Bumped whenever the shape of a capture response changes incompatibly. */
export const PROTOCOL_VERSION = 1;

/**
 * Summary statistics for a numeric channel or column.
 *
 * Invariant, and the reason this type exists at all: these are always computed
 * over the *complete* value, before any decimation or truncation. A plot may
 * show 2000 of 4 million points, but the min/max/NaN counts shown next to it
 * still describe all 4 million. Silently reporting statistics of a subsample is
 * the single easiest way for a debugging tool to mislead someone.
 */
export const numericStatsSchema = z.object({
  /** Number of elements considered, including NaN and Inf. */
  count: z.number().int().nonnegative(),
  /** Extremes over finite values only; null when there are none. */
  min: z.number().nullable(),
  max: z.number().nullable(),
  mean: z.number().nullable(),
  std: z.number().nullable(),
  nanCount: z.number().int().nonnegative(),
  infCount: z.number().int().nonnegative(),
});
export type NumericStats = z.infer<typeof numericStatsSchema>;

/**
 * What a channel is for. The webview uses this to wire channels up to a
 * visualization without having to guess from names.
 */
export const channelRoleSchema = z.enum([
  "x",
  "y",
  "value",
  "open",
  "high",
  "low",
  "close",
  "binEdge",
  "binCount",
  "label",
]);
export type ChannelRole = z.infer<typeof channelRoleSchema>;

/**
 * One contiguous run of numbers inside the payload buffer.
 *
 * Channels are how we avoid ever putting bulk numeric data through JSON: the
 * descriptor stays small and human-readable, and every actual number lives in a
 * single flat byte buffer that decodes to a TypedArray with zero copying.
 */
export const channelSchema = z.object({
  name: z.string(),
  role: channelRoleSchema,
  dtype: wireDtypeSchema,
  length: z.number().int().nonnegative(),
  byteOffset: z.number().int().nonnegative(),
  byteLength: z.number().int().nonnegative(),
  stats: numericStatsSchema.nullable(),
});
export type Channel = z.infer<typeof channelSchema>;

/**
 * Records that the transferred payload is a reduction of the real value.
 *
 * Always surfaced in the UI. The user must never be left believing they are
 * looking at every point when they are not.
 */
export const decimationSchema = z.object({
  method: z.enum(["lttb", "minmax", "stride"]),
  originalLength: z.number().int().nonnegative(),
  outputLength: z.number().int().nonnegative(),
});
export type Decimation = z.infer<typeof decimationSchema>;

/**
 * The visible slice of the x axis, when the capture was restricted to one.
 *
 * Its statistics are separate from `Descriptor.stats` on purpose: those always
 * describe the complete value, and zooming must not quietly redefine them. The
 * property that makes them trustworthy is that they do not move with the view.
 */
export const windowSchema = z.object({
  from: z.number(),
  to: z.number(),
  stats: numericStatsSchema.nullable(),
});
export type WindowInfo = z.infer<typeof windowSchema>;

export const timeUnitSchema = z.enum(["s", "ms", "us", "ns"]);
export type TimeUnit = z.infer<typeof timeUnitSchema>;

export const indexInfoSchema = z.object({
  kind: z.enum([
    "range",
    "integer",
    "float",
    "datetime",
    "timedelta",
    "categorical",
    "multi",
    "other",
  ]),
  name: z.string().nullable(),
  /** Native dtype string, e.g. "datetime64[ns]". */
  dtype: z.string().nullable(),
  /** Name of the channel carrying index values, or null if it is implicit 0..n-1. */
  channel: z.string().nullable(),
  /** For datetime/timedelta indexes: the unit the channel's numbers are in. */
  timeUnit: timeUnitSchema.nullable(),
});
export type IndexInfo = z.infer<typeof indexInfoSchema>;

export const columnInfoSchema = z.object({
  name: z.string(),
  /** Native dtype string, e.g. "float64", "object", "category". */
  dtype: z.string(),
  /** Whether this column could be converted to a numeric channel. */
  numeric: z.boolean(),
  /** Name of the channel carrying this column's values, or null if not transferred. */
  channel: z.string().nullable(),
  stats: numericStatsSchema.nullable(),
});
export type ColumnInfo = z.infer<typeof columnInfoSchema>;

export const valueKindSchema = z.enum([
  "scalar",
  "ndarray",
  "series",
  "frame",
  "index",
  "sequence",
  "mapping",
  "object",
  "unsupported",
]);
export type ValueKind = z.infer<typeof valueKindSchema>;

export const vizKindSchema = z.enum([
  "line",
  "scatter",
  "histogram",
  "heatmap",
  "image",
  "grid",
  "tree",
  "scalar",
]);
export type VizKind = z.infer<typeof vizKindSchema>;

/**
 * Everything known about a captured value except its bulk numbers.
 *
 * Deliberately self-describing: the webview picks a visualization, labels axes
 * and renders the stats strip from this object alone, without knowing which
 * Python adapter produced it. That is what lets third-party adapters plug in
 * without touching the UI.
 */
export const descriptorSchema = z.object({
  kind: valueKindSchema,
  /** Fully qualified Python type, e.g. "numpy.ndarray", "pandas.core.frame.DataFrame". */
  pythonType: z.string(),
  /** Short, always-safe-to-display repr. Length-capped by the runtime. */
  preview: z.string(),
  shape: z.array(z.number().int().nonnegative()).nullable(),
  /** Native dtype string as Python sees it, e.g. "float64". */
  dtype: z.string().nullable(),
  /** In-memory size of the original value, not of the payload. */
  nbytes: z.number().int().nonnegative().nullable(),
  stats: numericStatsSchema.nullable(),
  index: indexInfoSchema.nullable(),
  columns: z.array(columnInfoSchema).nullable(),
  channels: z.array(channelSchema),
  decimation: decimationSchema.nullable(),
  /** Set when the capture covers only part of the x axis, after zooming. */
  window: windowSchema.nullable(),
  /** True when parts of the value were dropped entirely (e.g. columns beyond a cap). */
  truncated: z.boolean(),
  /** Adapter's ranked suggestions; the webview may override. */
  suggestedViz: z.array(vizKindSchema),
});
export type Descriptor = z.infer<typeof descriptorSchema>;
