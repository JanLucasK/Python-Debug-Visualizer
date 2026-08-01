/**
 * Colormaps, implemented here rather than taken from matplotlib.
 *
 * Requiring matplotlib in the debuggee to colour a heatmap would break the
 * project's central promise — that nothing needs installing. Each map is stored
 * as a handful of anchor colours and interpolated into a 256-entry lookup
 * table on first use, which costs about a kilobyte of source for all of them.
 */

export type ColormapName = "viridis" | "magma" | "plasma" | "blues" | "coolwarm" | "gray";

type Anchor = readonly [number, number, number];

/**
 * `viridis` is the default despite the usual advice to prefer a single hue for
 * sequential data. The reasons that advice exists — perceptual uniformity,
 * monotonic lightness, colour-vision safety — are exactly the properties
 * viridis was constructed to have, and it is what anyone coming from matplotlib
 * expects to see. The caution is aimed at rainbow maps like jet, whose
 * lightness is not monotonic and which invent structure that is not in the
 * data. `blues` is here for anyone who wants the single-hue version.
 */
const ANCHORS: Record<ColormapName, readonly Anchor[]> = {
  viridis: [
    [68, 1, 84],
    [72, 40, 120],
    [62, 73, 137],
    [49, 104, 142],
    [38, 130, 142],
    [31, 158, 137],
    [53, 183, 121],
    [110, 206, 88],
    [253, 231, 37],
  ],
  magma: [
    [0, 0, 4],
    [24, 15, 61],
    [68, 15, 118],
    [114, 31, 129],
    [158, 47, 127],
    [205, 64, 113],
    [241, 96, 93],
    [253, 150, 104],
    [252, 253, 191],
  ],
  plasma: [
    [13, 8, 135],
    [75, 3, 161],
    [125, 3, 168],
    [168, 34, 150],
    [203, 70, 121],
    [229, 107, 93],
    [248, 148, 65],
    [253, 195, 40],
    [240, 249, 33],
  ],
  // The single-hue sequential ramp: one hue, light to dark.
  blues: [
    [205, 226, 251],
    [158, 197, 244],
    [109, 167, 236],
    [57, 135, 229],
    [37, 106, 191],
    [24, 79, 149],
    [13, 54, 107],
  ],
  // Diverging: two opposing hues around a neutral grey midpoint, so "zero"
  // reads as nothing rather than as a colour of its own.
  coolwarm: [
    [59, 76, 192],
    [123, 159, 249],
    [221, 221, 221],
    [246, 163, 133],
    [180, 4, 38],
  ],
  gray: [
    [0, 0, 0],
    [255, 255, 255],
  ],
};

export const COLORMAP_NAMES = Object.keys(ANCHORS) as ColormapName[];

/** Maps that read as "distance from a midpoint" and should be centred on zero. */
export const DIVERGING_COLORMAPS: ReadonlySet<ColormapName> = new Set<ColormapName>(["coolwarm"]);

const LUT_SIZE = 256;
const cache = new Map<ColormapName, Uint8ClampedArray>();

/** RGB lookup table with `LUT_SIZE` entries, three bytes each. */
export function lookupTable(name: ColormapName): Uint8ClampedArray {
  const cached = cache.get(name);
  if (cached) return cached;

  const anchors = ANCHORS[name];
  const table = new Uint8ClampedArray(LUT_SIZE * 3);
  const segments = anchors.length - 1;

  for (let i = 0; i < LUT_SIZE; i++) {
    const position = (i / (LUT_SIZE - 1)) * segments;
    const index = Math.min(Math.floor(position), segments - 1);
    const t = position - index;
    const from = anchors[index] as Anchor;
    const to = anchors[index + 1] as Anchor;

    table[i * 3] = from[0] + (to[0] - from[0]) * t;
    table[i * 3 + 1] = from[1] + (to[1] - from[1]) * t;
    table[i * 3 + 2] = from[2] + (to[2] - from[2]) * t;
  }

  cache.set(name, table);
  return table;
}

export function sampleColormap(name: ColormapName, fraction: number): string {
  const table = lookupTable(name);
  const index = Math.max(0, Math.min(LUT_SIZE - 1, Math.round(fraction * (LUT_SIZE - 1)))) * 3;
  return `rgb(${table[index]}, ${table[index + 1]}, ${table[index + 2]})`;
}
