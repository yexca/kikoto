/**
 * Image viewer zoom: `"fit"` shows the whole image inside the stage, and a
 * number is a scale of the image's natural pixels.
 */
export type ImageZoom = "fit" | number;

/** The largest scale of natural pixels the viewer zooms to. */
export const maxImageZoom = 8;

/** One keyboard zoom step. */
export const imageZoomStep = 1.25;

/**
 * Settles a requested scale: anything at or below the fitted scale returns to
 * fit, and nothing grows past `maxImageZoom`.
 */
export function clampImageZoom(scale: number, fitScale: number): ImageZoom {
  if (!Number.isFinite(scale) || scale <= fitScale * 1.001) return "fit";
  return Math.min(scale, Math.max(maxImageZoom, fitScale));
}

export function imageZoomScale(zoom: ImageZoom, fitScale: number) {
  return zoom === "fit" ? fitScale : zoom;
}

/** A click on the fitted image shows actual size, or doubles an image that already fits at actual size. */
export function imageClickZoom(fitScale: number) {
  return fitScale < 0.999 ? 1 : fitScale * 2;
}

const wheelLinePixels = 16;
const wheelPagePixels = 400;
// Mouse wheel notches report about 100px; trackpad pinches arrive as small ctrl+wheel deltas.
const wheelPixelsLimit = 100;
const wheelZoomRate = 0.002;
const pinchWheelZoomRate = 0.01;

/** The scale factor for one wheel event; `pinch` is a trackpad pinch, which browsers report with ctrlKey. */
export function wheelZoomFactor(deltaY: number, deltaMode: number, pinch: boolean) {
  const pixels = deltaMode === 1 ? deltaY * wheelLinePixels : deltaMode === 2 ? deltaY * wheelPagePixels : deltaY;
  const bounded = Math.max(-wheelPixelsLimit, Math.min(wheelPixelsLimit, pixels));
  return Math.exp(-bounded * (pinch ? pinchWheelZoomRate : wheelZoomRate));
}
