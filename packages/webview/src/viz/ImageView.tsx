import { useLayoutEffect, useMemo, useRef } from "preact/hooks";
import type { VizProps } from "./registry";

/**
 * An H×W×3 or H×W×4 array as a picture.
 *
 * Separate from the heatmap because the numbers already *are* colours: there is
 * no scale to choose and no colormap to apply. Scaling is nearest-neighbour for
 * the same reason as the heatmap — a smoothed image invents pixels that are not
 * in the array.
 */
export function ImageView({ descriptor, decoded }: VizProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const image = useMemo(() => collectImage(descriptor, decoded), [descriptor, decoded]);

  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element || !image) return;

    element.width = image.cols;
    element.height = image.rows;
    element.getContext("2d")?.putImageData(toImageData(image), 0, 0);
  }, [image]);

  if (!image) {
    return <div className="notice warning">This capture has no image data.</div>;
  }

  return (
    <div className="image-view">
      <div className="image-canvas-wrap">
        <canvas ref={canvas} className="image-canvas" aria-label="Image" />
      </div>
      <p className="image-caption">
        {image.rows} × {image.cols} × {image.channels}
      </p>
    </div>
  );
}

interface Picture {
  rows: number;
  cols: number;
  channels: 3 | 4;
  bytes: Float64Array;
}

function collectImage(
  { shape }: VizProps["descriptor"],
  decoded: VizProps["decoded"],
): Picture | undefined {
  if (!shape || shape.length !== 3) return undefined;
  const [rows, cols, depth] = shape as [number, number, number];
  if (depth !== 3 && depth !== 4) return undefined;

  const channel = decoded.channels.get("pixel");
  if (!channel || channel.values.length < rows * cols * depth) return undefined;

  return { rows, cols, channels: depth, bytes: channel.values };
}

function toImageData(picture: Picture): ImageData {
  const image = new ImageData(picture.cols, picture.rows);
  const pixels = image.data;
  const { channels, bytes } = picture;

  for (let i = 0; i < picture.rows * picture.cols; i++) {
    const source = i * channels;
    const target = i * 4;
    pixels[target] = bytes[source] as number;
    pixels[target + 1] = bytes[source + 1] as number;
    pixels[target + 2] = bytes[source + 2] as number;
    // A three-channel image is opaque; a four-channel one carries its own alpha.
    pixels[target + 3] = channels === 4 ? (bytes[source + 3] as number) : 255;
  }

  return image;
}
