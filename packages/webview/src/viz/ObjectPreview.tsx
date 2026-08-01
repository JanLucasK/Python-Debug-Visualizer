import type { VizProps } from "./registry";

/**
 * The fallback: whatever the value is, show what Python said about it.
 *
 * Reached for dicts, custom classes, complex arrays and anything else that
 * cannot be plotted. Being unable to chart something is not a reason to show
 * nothing about it — the type, shape and repr are usually enough to answer the
 * question that prompted the look.
 */
export function ObjectPreview({ descriptor }: VizProps) {
  return (
    <div className="object-preview">
      <pre>{descriptor.preview}</pre>
    </div>
  );
}
