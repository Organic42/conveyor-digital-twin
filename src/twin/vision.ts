/**
 * Vision node for CAM-201. Classical, explainable pipeline on the captured frame:
 *   linear → sRGB, RGB → HSV, segment the carton from the belt (saturation / value),
 *   measure the red-label area inside the carton blob, decide GOOD / DEFECT / NO_READ.
 */
import type { Verdict } from '../plant/model';

export interface InspectionResult {
  verdict: Verdict;
  objectRatio: number; // carton pixels / ROI
  defectRatio: number; // red pixels / carton pixels
  confidence: number;
  bbox: [number, number, number, number] | null;
  ms: number;
}

const MIN_OBJECT = 0.04;
const DEFECT_THRESHOLD = 0.06;

const toSrgb = (c: number) => {
  const x = c / 255;
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
};
const LUT = Uint8ClampedArray.from({ length: 256 }, (_, i) => Math.round(toSrgb(i) * 255));

/** Converts a linear RGBA buffer (WebGL render target) to an sRGB, top-down ImageData in place. */
export function toDisplayImage(px: Uint8Array, w: number, h: number): ImageData {
  const img = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w * 4;
    const dst = y * w * 4;
    for (let x = 0; x < w * 4; x += 4) {
      img.data[dst + x] = LUT[px[src + x]];
      img.data[dst + x + 1] = LUT[px[src + x + 1]];
      img.data[dst + x + 2] = LUT[px[src + x + 2]];
      img.data[dst + x + 3] = 255;
    }
  }
  return img;
}

export function inspect(img: ImageData): InspectionResult {
  const t0 = performance.now();
  const { width: w, height: h, data } = img;
  let object = 0;
  let red = 0;
  let sum = 0;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = data[i] / 255;
      const g = data[i + 1] / 255;
      const b = data[i + 2] / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const v = max;
      const s = max > 0 ? (max - min) / max : 0;
      sum += v;
      if (s < 0.3 || v < 0.22) continue; // belt, frame, shadow

      object++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;

      let hue = 0;
      const d = max - min;
      if (max === r) hue = 60 * (((g - b) / d) % 6);
      else if (max === g) hue = 60 * ((b - r) / d + 2);
      else hue = 60 * ((r - g) / d + 4);
      if (hue < 0) hue += 360;
      if ((hue < 14 || hue > 340) && s > 0.55) red++;
    }
  }

  const n = w * h;
  const meanV = sum / n;
  const objectRatio = object / n;
  const defectRatio = object > 0 ? red / object : 0;
  let verdict: Verdict;
  let confidence: number;
  if (meanV < 0.04 || objectRatio < MIN_OBJECT) {
    verdict = 'NO_READ';
    confidence = 0;
  } else if (defectRatio > DEFECT_THRESHOLD) {
    verdict = 'DEFECT';
    confidence = Math.min(1, 0.6 + (defectRatio - DEFECT_THRESHOLD) * 4);
  } else {
    verdict = 'GOOD';
    confidence = Math.min(1, 0.6 + (DEFECT_THRESHOLD - defectRatio) * 6);
  }
  return {
    verdict,
    objectRatio,
    defectRatio,
    confidence,
    bbox: object > 0 ? [x0, y0, x1, y1] : null,
    ms: performance.now() - t0,
  };
}
