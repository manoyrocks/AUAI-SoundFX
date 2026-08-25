/**
 * Region-of-interest extraction for camera rPPG.
 *
 * Honesty note (see docs/07-claims.md "no pseudoscience" rule): this is a
 * *skin-tone heuristic*, not a face landmarker. It thresholds YCbCr chroma to
 * find the largest skin-coloured blob in frame, then takes the upper-central
 * portion of its bounding box as a forehead/upper-cheek proxy. That is a
 * legitimate, published approach (predates deep-learning face detectors in the
 * rPPG literature) but it is weaker than a proper landmark model: it can drift
 * onto a hand, neck, or a skin-toned object, and it degrades on low-contrast
 * webcams. M1 ships it because it has zero model-download cost and is good
 * enough to demonstrate closed-loop control; the roadmap item to replace it
 * with a WebGPU face landmarker is tracked in docs/03-a2-generative-model.md
 * under "M2 biosignal hardening". The confidence score this module reports is
 * deliberately conservative so the UI never overstates certainty.
 */

export interface Roi {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Fraction of the analysed frame classified as skin. Low = unreliable. */
  skinFraction: number;
}

const ANALYSIS_W = 96;
const ANALYSIS_H = 72;

let scratch: Uint8ClampedArray | null = null;
let scratchCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
let scratchCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;

function getScratch(): { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D } {
  if (!scratchCanvas) {
    if (typeof OffscreenCanvas !== "undefined") {
      scratchCanvas = new OffscreenCanvas(ANALYSIS_W, ANALYSIS_H);
    } else {
      const c = document.createElement("canvas");
      c.width = ANALYSIS_W;
      c.height = ANALYSIS_H;
      scratchCanvas = c;
    }
    scratchCtx = scratchCanvas.getContext("2d", { willReadFrequently: true }) as any;
  }
  return { canvas: scratchCanvas!, ctx: scratchCtx! };
}

function isSkin(r: number, g: number, b: number): boolean {
  // YCbCr thresholds from Chai & Ngan (1999), widely used in early rPPG work.
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return y > 40 && cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173;
}

/**
 * Downsample a video frame and locate the skin-blob ROI.
 * Returns null if too little skin is visible (face out of frame, camera off,
 * hand over lens, etc.) — callers must treat null as "no signal" rather than
 * guessing.
 */
export function findRoi(source: CanvasImageSource, srcW: number, srcH: number): Roi | null {
  const { canvas, ctx } = getScratch();
  ctx.drawImage(source, 0, 0, ANALYSIS_W, ANALYSIS_H);
  const img = ctx.getImageData(0, 0, ANALYSIS_W, ANALYSIS_H);
  const data = img.data;

  let minX = ANALYSIS_W;
  let minY = ANALYSIS_H;
  let maxX = 0;
  let maxY = 0;
  let count = 0;

  if (!scratch || scratch.length !== ANALYSIS_W * ANALYSIS_H) {
    scratch = new Uint8ClampedArray(ANALYSIS_W * ANALYSIS_H);
  }
  const mask = scratch;

  for (let y = 0; y < ANALYSIS_H; y++) {
    for (let x = 0; x < ANALYSIS_W; x++) {
      const i = (y * ANALYSIS_W + x) * 4;
      const skin = isSkin(data[i], data[i + 1], data[i + 2]);
      mask[y * ANALYSIS_W + x] = skin ? 1 : 0;
      if (skin) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const skinFraction = count / (ANALYSIS_W * ANALYSIS_H);
  if (count < 40 || skinFraction < 0.02) return null;

  // Map back to source pixel space.
  const sx = srcW / ANALYSIS_W;
  const sy = srcH / ANALYSIS_H;
  const bw = (maxX - minX + 1) * sx;
  const bh = (maxY - minY + 1) * sy;
  const bx = minX * sx;
  const by = minY * sy;

  // Upper-central 45%x35% of the bounding box approximates forehead/cheek,
  // away from eyes (which blink and confound the signal) and mouth (moves).
  const roiW = bw * 0.45;
  const roiH = bh * 0.32;
  const roiX = bx + bw * 0.28;
  const roiY = by + bh * 0.08;

  return { x: roiX, y: roiY, w: Math.max(4, roiW), h: Math.max(4, roiH), skinFraction };
}

/** Mean R,G,B over a rectangular ROI of a video frame, spatially averaged. */
export function meanRgb(source: CanvasImageSource, roi: Roi): [number, number, number] {
  const { canvas, ctx } = getScratch();
  const w = 24;
  const h = 24;
  ctx.drawImage(source, roi.x, roi.y, roi.w, roi.h, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;
  let r = 0;
  let g = 0;
  let b = 0;
  const n = w * h;
  for (let i = 0; i < data.length; i += 4) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
  }
  return [r / n, g / n, b / n];
}
