/**
 * Statistical process control. Limits come from a baseline of the first samples after a
 * (re)start; afterwards every new sample is tested against the Western Electric rules.
 *   I-chart: σ = MR̄ / 1.128       p-chart: σ = √(p̄(1 − p̄) / n)
 */

export type SpcRule = 'R1' | 'R2' | 'R3' | 'R4';

export const RULE_TEXT: Record<SpcRule, string> = {
  R1: 'point beyond 3σ',
  R2: '2 of 3 points beyond 2σ',
  R3: '8 points on one side of centre',
  R4: '6 points steadily trending',
};

export interface Limits {
  centre: number;
  ucl: number;
  lcl: number;
  sigma: number;
}

export interface SpcSample {
  n: number;
  ts: number;
  value: number;
  rule: SpcRule | null;
}

export type SpcStatus = 'COLLECTING' | 'IN CONTROL' | 'OUT OF CONTROL';

export class ControlChart {
  readonly samples: SpcSample[] = [];
  limits: Limits | null = null;
  lastSignal: SpcSample | null = null;
  private baseline: number[] = [];
  private count = 0;

  constructor(
    readonly kind: 'I' | 'p',
    readonly baselineSize: number,
    readonly subgroupSize = 1,
    private readonly keep = 60,
  ) {}

  add(ts: number, value: number): SpcSample {
    const s: SpcSample = { n: ++this.count, ts, value, rule: null };
    this.samples.push(s);
    if (this.samples.length > this.keep) this.samples.shift();

    if (!this.limits) {
      this.baseline.push(value);
      if (this.baseline.length >= this.baselineSize) this.limits = this.computeLimits(this.baseline);
      return s;
    }
    s.rule = this.evaluate();
    if (s.rule) this.lastSignal = s;
    return s;
  }

  rebaseline(): void {
    this.limits = null;
    this.baseline = [];
    this.samples.length = 0;
    this.lastSignal = null;
  }

  get collected(): number {
    return this.baseline.length;
  }

  get status(): SpcStatus {
    if (!this.limits) return 'COLLECTING';
    return this.samples.slice(-10).some((s) => s.rule) ? 'OUT OF CONTROL' : 'IN CONTROL';
  }

  private computeLimits(xs: number[]): Limits {
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    let sigma: number;
    if (this.kind === 'p') {
      sigma = Math.max(0.01, Math.sqrt((mean * (1 - mean)) / this.subgroupSize));
    } else {
      let mr = 0;
      for (let i = 1; i < xs.length; i++) mr += Math.abs(xs[i] - xs[i - 1]);
      sigma = Math.max(1e-3, mr / (xs.length - 1) / 1.128);
    }
    const lo = mean - 3 * sigma;
    return { centre: mean, sigma, ucl: mean + 3 * sigma, lcl: this.kind === 'p' ? Math.max(0, lo) : lo };
  }

  /** Western Electric rules on the samples collected since the limits were set. */
  private evaluate(): SpcRule | null {
    const L = this.limits!;
    const xs = this.samples.slice(-8).map((s) => s.value);
    const last = xs[xs.length - 1];
    const z = (x: number) => (x - L.centre) / L.sigma;

    if (Math.abs(z(last)) > 3) return 'R1';
    const last3 = xs.slice(-3);
    if (last3.length === 3) {
      const hi = last3.filter((x) => z(x) > 2).length;
      const lo = last3.filter((x) => z(x) < -2).length;
      if ((hi >= 2 && z(last) > 2) || (lo >= 2 && z(last) < -2)) return 'R2';
    }
    if (xs.length === 8 && (xs.every((x) => x > L.centre) || xs.every((x) => x < L.centre))) return 'R3';
    const last6 = xs.slice(-6);
    if (last6.length === 6) {
      let up = true;
      let down = true;
      for (let i = 1; i < 6; i++) {
        if (last6[i] <= last6[i - 1]) up = false;
        if (last6[i] >= last6[i - 1]) down = false;
      }
      if (up || down) return 'R4';
    }
    return null;
  }
}
