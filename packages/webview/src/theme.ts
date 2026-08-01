/**
 * Reads chart colors out of the live CSS custom properties.
 *
 * uPlot draws to a canvas, so it needs resolved color values rather than
 * `var(--series-1)`. Resolving them here — from the same custom properties the
 * stylesheet defines — keeps a single source of truth and means a theme switch
 * updates the plots along with everything else.
 */

/** Fixed categorical order. Assigned by position, never cycled. */
const SERIES_SLOTS = 8;

export interface ChartTheme {
  series: string[];
  axis: string;
  grid: string;
  cursor: string;
}

export function readTheme(): ChartTheme {
  const style = getComputedStyle(document.documentElement);
  const value = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;

  const series: string[] = [];
  for (let slot = 1; slot <= SERIES_SLOTS; slot++) {
    series.push(value(`--series-${slot}`, "#2a78d6"));
  }

  return {
    series,
    axis: value("--vscode-descriptionForeground", "#8b8b8b"),
    // Grid and axis lines stay recessive; the data is what should carry weight.
    grid: withAlpha(value("--vscode-panel-border", "#80808040"), 0.5),
    cursor: value("--vscode-editorCursor-foreground", "#888888"),
  };
}

/**
 * The color for series `index`.
 *
 * Beyond the eighth slot this repeats, which is a deliberate last resort rather
 * than a design: callers are expected to cap the series count and say so. Two
 * series sharing a color is bad, but inventing a ninth hue would produce one
 * that fails the contrast and color-vision checks the fixed eight passed.
 */
export function seriesColor(theme: ChartTheme, index: number): string {
  return theme.series[index % SERIES_SLOTS] ?? theme.series[0] ?? "#2a78d6";
}

export const MAX_SERIES = SERIES_SLOTS;

/** Watches for VS Code swapping the theme class on <body>. */
export function onThemeChange(handler: () => void): () => void {
  const observer = new MutationObserver(handler);
  observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

function withAlpha(color: string, alpha: number): string {
  if (color.startsWith("#") && (color.length === 7 || color.length === 4)) {
    const hex = color.length === 4 ? expandShorthand(color) : color;
    const channel = Math.round(alpha * 255)
      .toString(16)
      .padStart(2, "0");
    return `${hex}${channel}`;
  }
  return color;
}

function expandShorthand(color: string): string {
  return `#${color
    .slice(1)
    .split("")
    .map((c) => c + c)
    .join("")}`;
}
