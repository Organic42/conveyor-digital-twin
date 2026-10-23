/**
 * Vision tunnel (CAM-201 … CAM-205). Classical, explainable pipeline per camera image:
 *   1. linear → sRGB, RGB → HSV per pixel
 *   2. segment the carton by its cardboard colour (hue 15–50°, saturated, not dark)
 *   3. inside the carton's bounding box count defect pixels:
 *        red  (hue < 14° or > 340°)  → wrong label
 *        blue (hue 190–265°)         → ink contamination
 *   4. per view: NO_READ (no image / carton not found) · DEFECT (defect area > 5 %) · GOOD
 * The views are then fused: any DEFECT → DEFECT; else any NO_READ → NO_READ (fail-safe); else GOOD.
 */
import type { Verdict } from '../plant/model';
import { CAMERAS, type CameraId, type DefectKind, type Face } from '../plant/params';

export const VISION_RULES = {
  cardboardHue: [15, 50] as const,
  cardboardMinSat: 0.28,
  cardboardMinVal: 0.15,
  redHue: [14, 340] as const, // below the first or above the second
  redMinSat: 0.5,
  blueHue: [190, 265] as const,
  blueMinSat: 0.35,
  minCartonShare: 0.03, // carton must cover ≥ 3 % of the image
  darkFrame: 0.04, // mean brightness below this = no image
  defectShare: 0.05, // defect pixels / carton pixels
};

export interface ViewResult {
  camera: CameraId;
  face: Face;
  verdict: Verdict;
  cartonShare: number;
  defectShare: number;
  defectKind: DefectKind | null;
  bbox: [number, number, number, number] | null;
}

export interface InspectionResult {
  verdict: Verdict;
  views: ViewResult[];
  /** View that decided a DEFECT / NO_READ verdict. */
  cause: ViewResult | null;
  reason: string;
  confidence: number;
  ms: number;
}

const toSrgb = (c: number) => {
  const x = c / 255;
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
};
const LUT = Uint8ClampedArray.from({ length: 256 }, (_, i) => Math.round(toSrgb(i) * 255));
const FACE_OF = Object.fromEntries(CAMERAS.map((c) => [c.id, c.face])) as Record<CameraId, Face>;
const LABEL_OF = Object.fromEntries(CAMERAS.map((c) => [c.id, c.label])) as Record<CameraId, string>;

/** Converts a linear RGBA buffer (WebGL render target, bottom-up rows) to a top-down sRGB ImageData. */
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

/** 0 = background, 1 = cardboard, 2 = red, 3 = blue */
function classify(r: number, g: number, b: number): number {
  const R = VISION_RULES;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const v = max;
  const s = max > 0 ? (max - min) / max : 0;
  if (s < 0.2) return 0;
  const d = max - min;
  let hue: number;
  if (max === r) hue = 60 * (((g - b) / d) % 6);
  else if (max === g) hue = 60 * ((b - r) / d + 2);
  else hue = 60 * ((r - g) / d + 4);
  if (hue < 0) hue += 360;
  if (hue >= R.cardboardHue[0] && hue <= R.cardboardHue[1] && s > R.cardboardMinSat && v > R.cardboardMinVal) return 1;
  if ((hue < R.redHue[0] || hue > R.redHue[1]) && s > R.redMinSat && v > 0.22) return 2;
  if (hue >= R.blueHue[0] && hue <= R.blueHue[1] && s > R.blueMinSat && v > 0.12) return 3;
  return 0;
}

export function inspectView(img: ImageData, camera: CameraId): ViewResult {
  const { width: w, height: h, data } = img;
  const cls = new Uint8Array(w * h);
  let carton = 0;
  let sum = 0;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const r = data[i * 4] / 255;
      const g = data[i * 4 + 1] / 255;
      const b = data[i * 4 + 2] / 255;
      sum += Math.max(r, g, b);
      const c = classify(r, g, b);
      cls[i] = c;
      if (c === 1) {
        carton++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  const base = { camera, face: FACE_OF[camera] };
  const n = w * h;
  if (sum / n < VISION_RULES.darkFrame || carton / n < VISION_RULES.minCartonShare) {
    return { ...base, verdict: 'NO_READ', cartonShare: carton / n, defectShare: 0, defectKind: null, bbox: carton ? [x0, y0, x1, y1] : null };
  }

  // Defect pixels inside the carton's bounding box (slightly enlarged: labels sit on the surface)
  let red = 0;
  let blue = 0;
  const bx0 = Math.max(0, x0 - 2);
  const by0 = Math.max(0, y0 - 2);
  const bx1 = Math.min(w - 1, x1 + 2);
  const by1 = Math.min(h - 1, y1 + 2);
  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      const c = cls[y * w + x];
      if (c === 2) red++;
      else if (c === 3) blue++;
    }
  }
  const defectShare = (red + blue) / (carton + red + blue);
  const isDefect = defectShare > VISION_RULES.defectShare;
  return {
    ...base,
    verdict: isDefect ? 'DEFECT' : 'GOOD',
    cartonShare: carton / n,
    defectShare,
    defectKind: isDefect ? (red >= blue ? 'label' : 'stain') : null,
    bbox: [x0, y0, x1, y1],
  };
}

/** Fuses per-camera verdicts. Only cameras in `enabled` take part in the decision. */
export function fuse(views: ViewResult[], enabled: ReadonlySet<CameraId>, ms: number): InspectionResult {
  const used = views.filter((v) => enabled.has(v.camera));
  const defects = used.filter((v) => v.verdict === 'DEFECT').sort((a, b) => b.defectShare - a.defectShare);
  const noReads = used.filter((v) => v.verdict === 'NO_READ');
  if (defects.length) {
    const c = defects[0];
    const kind = c.defectKind === 'label' ? 'wrong label' : 'ink stain';
    return {
      verdict: 'DEFECT',
      views,
      cause: c,
      reason: `${kind} on ${c.face} face (${LABEL_OF[c.camera]}, ${(c.defectShare * 100).toFixed(0)} % of carton)`,
      confidence: Math.min(1, 0.6 + (c.defectShare - VISION_RULES.defectShare) * 3),
      ms,
    };
  }
  if (noReads.length || !used.length) {
    const c = noReads[0] ?? null;
    return {
      verdict: 'NO_READ',
      views,
      cause: c,
      reason: c ? `${LABEL_OF[c.camera]} could not see the carton — fail-safe reject` : 'no cameras enabled',
      confidence: 0,
      ms,
    };
  }
  const worst = Math.max(...used.map((v) => v.defectShare));
  return {
    verdict: 'GOOD',
    views,
    cause: null,
    reason: `${used.length} faces clean (max defect area ${(worst * 100).toFixed(1)} %)`,
    confidence: Math.min(1, 0.6 + (VISION_RULES.defectShare - worst) * 8),
    ms,
  };
}
