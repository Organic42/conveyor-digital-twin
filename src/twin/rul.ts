/**
 * Remaining useful life from a condition indicator. The indicator is recorded once per second
 * while the line runs steadily; a straight-line degradation model fitted to the last minute is
 * extrapolated to the failure threshold, with a band from the slope's standard error.
 */

export interface RulOptions {
  threshold: number; // failure level of the indicator
  rising: boolean; // true if the indicator grows as the asset degrades
  minDelta: number; // minimum change over the window to call it a trend
  minSlopePerS: number; // minimum |slope| [units/s]
}

export interface RulEstimate {
  rulS: number | null; // seconds to threshold, null = no degradation trend
  lowS: number | null; // pessimistic (steeper slope)
  highS: number | null; // optimistic (shallower slope)
  slopePerMin: number; // indicator units per minute
  threshold: number;
  fit: { a: number; b: number; t0: number } | null; // value = a + b·(t − t0), t in s
}

const WINDOW = 60; // points (s)

export class RulEstimator {
  readonly history: [number, number][] = []; // [unix s, value]
  private lastTs = 0;

  constructor(readonly opts: RulOptions) {}

  get threshold(): number {
    return this.opts.threshold;
  }

  update(ts: number, value: number, steady: boolean): void {
    if (!steady || ts - this.lastTs < 1000) return;
    this.lastTs = ts;
    this.history.push([ts / 1000, value]);
    if (this.history.length > 900) this.history.shift();
  }

  reset(): void {
    this.history.length = 0;
  }

  estimate(): RulEstimate {
    const { threshold, rising, minDelta, minSlopePerS } = this.opts;
    const none: RulEstimate = { rulS: null, lowS: null, highS: null, slopePerMin: 0, threshold, fit: null };
    const pts = this.history.slice(-WINDOW);
    if (pts.length < 15) return none;
    const t0 = pts[0][0];
    const n = pts.length;
    const xs = pts.map(([t]) => t - t0);
    const ys = pts.map(([, v]) => v);
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
    if (sxx <= 0) return none;
    const b = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / sxx;
    const a = my - b * mx;
    const resid = ys.reduce((s, y, i) => s + (y - (a + b * xs[i])) ** 2, 0);
    const se = Math.sqrt(resid / Math.max(1, n - 2) / sxx);
    const tNow = xs[n - 1];
    const vNow = a + b * tNow;
    const base: RulEstimate = { ...none, slopePerMin: b * 60, fit: { a, b, t0 } };

    const sign = rising ? 1 : -1; // degrade in the direction of `sign`
    if (sign * (vNow - threshold) >= 0) return { ...base, rulS: 0, lowS: 0, highS: 0 };
    // A degradation trend needs a steady change in the failure direction, big enough over the
    // window and clearly different from zero (a one-off step is not wear)
    if (sign * b < minSlopePerS || sign * b * tNow < minDelta || Math.abs(b) < 3 * se) return base;
    const ttf = (slope: number) => (sign * slope > 0 ? Math.max(0, (threshold - a) / slope - tNow) : null);
    return { ...base, rulS: ttf(b), lowS: ttf(b + sign * 2 * se), highS: ttf(b - sign * 2 * se) };
  }
}
