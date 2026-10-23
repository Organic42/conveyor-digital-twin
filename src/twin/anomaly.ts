/**
 * Learned anomaly model — multivariate statistical process monitoring with PCA.
 *
 *  Training:  standardise ~80 s of healthy feature vectors, eigen-decompose their covariance,
 *             keep the principal components that explain 90 % of the variance.
 *  Monitoring: Hotelling's T² (unusual combination inside the normal subspace) and
 *             Q / SPE (variation the normal model cannot explain).
 *  Explaining: per-feature contributions point at the asset behind the deviation.
 *
 * One model is learned per speed setpoint (operating mode); a new setpoint starts a new learning phase.
 */
import { FEATURES } from './features';

export interface PcaModel {
  mean: number[];
  std: number[];
  P: number[][]; // k loading vectors (length m)
  lambda: number[]; // k eigenvalues
  t2Limit: number;
  qLimit: number;
  varianceExplained: number;
}

export interface Contribution {
  feature: number;
  name: string;
  asset: string;
  share: number;
}

export interface AnomalyResult {
  ts: number;
  t2: number;
  q: number;
  t2Ratio: number;
  qRatio: number;
  anomalous: boolean;
  contributions: Contribution[];
}

export type AnomalyStatus = 'LEARNING' | 'NORMAL' | 'ANOMALY';

const TRAIN_SIZE = 40;
const PERSISTENCE = 4; // consecutive out-of-limit samples (8 s) before declaring an anomaly

export class AnomalyDetector {
  readonly trainSize = TRAIN_SIZE;
  readonly history: { ts: number; t2r: number; qr: number }[] = [];
  last: AnomalyResult | null = null;
  status: AnomalyStatus = 'LEARNING';
  mode = '';
  private models = new Map<string, PcaModel>();
  private training: number[][] = [];
  private over = 0;

  get progress(): number {
    return this.training.length;
  }

  get model(): PcaModel | undefined {
    return this.models.get(this.mode);
  }

  retrain(): void {
    this.models.delete(this.mode);
    this.training = [];
    this.status = 'LEARNING';
    this.over = 0;
  }

  add(ts: number, x: number[], speedSetpoint: number): AnomalyResult | null {
    const mode = speedSetpoint.toFixed(2);
    if (mode !== this.mode) {
      this.mode = mode;
      this.training = [];
      this.over = 0;
    }
    const model = this.models.get(mode);
    if (!model) {
      this.status = 'LEARNING';
      this.training.push(x);
      if (this.training.length >= TRAIN_SIZE) {
        this.models.set(mode, fit(this.training));
        this.training = [];
        this.status = 'NORMAL';
      }
      return null;
    }
    const r = evaluate(model, x, ts);
    this.over = r.t2Ratio > 1 || r.qRatio > 1 ? this.over + 1 : 0;
    r.anomalous = this.over >= PERSISTENCE;
    this.status = r.anomalous ? 'ANOMALY' : 'NORMAL';
    this.last = r;
    this.history.push({ ts, t2r: r.t2Ratio, qr: r.qRatio });
    if (this.history.length > 300) this.history.shift();
    return r;
  }
}

function fit(X: number[][]): PcaModel {
  const n = X.length;
  const m = X[0].length;
  const mean = Array.from({ length: m }, (_, j) => X.reduce((s, x) => s + x[j], 0) / n);
  const std = Array.from({ length: m }, (_, j) => {
    const v = X.reduce((s, x) => s + (x[j] - mean[j]) ** 2, 0) / (n - 1);
    return Math.max(Math.sqrt(v), FEATURES[j].floor);
  });
  const Z = X.map((x) => x.map((v, j) => (v - mean[j]) / std[j]));
  const C = Array.from({ length: m }, (_, a) =>
    Array.from({ length: m }, (_, b) => Z.reduce((s, z) => s + z[a] * z[b], 0) / (n - 1)),
  );
  const { values, vectors } = jacobiEigen(C);
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]);
  const total = values.reduce((s, v) => s + Math.max(0, v), 0) || 1;
  let k = 0;
  let cum = 0;
  while (k < m - 1 && (k === 0 || cum / total < 0.9)) {
    cum += Math.max(0, order[k][0]);
    k++;
  }
  const lambda = order.slice(0, k).map(([v]) => Math.max(v, 1e-3));
  const P = order.slice(0, k).map(([, i]) => vectors.map((row) => row[i]));
  const partial: PcaModel = { mean, std, P, lambda, t2Limit: 0, qLimit: 0, varianceExplained: cum / total };

  // Control limits: theoretical χ² for T², empirical + absolute floor for Q, both with margin
  const stats = X.map((x) => scores(partial, x));
  const t2Max = Math.max(...stats.map((s) => s.t2));
  const qs = stats.map((s) => s.q);
  const qMean = qs.reduce((a, b) => a + b, 0) / n;
  const qStd = Math.sqrt(qs.reduce((a, b) => a + (b - qMean) ** 2, 0) / (n - 1));
  partial.t2Limit = Math.max(chi2Quantile(k, 3.09), 1.3 * t2Max);
  partial.qLimit = Math.max(2.0, qMean + 4 * qStd, 1.5 * Math.max(...qs));
  return partial;
}

function scores(model: PcaModel, x: number[]) {
  const z = x.map((v, j) => (v - model.mean[j]) / model.std[j]);
  const t = model.P.map((p) => p.reduce((s, pj, j) => s + pj * z[j], 0));
  const zHat = z.map((_, j) => model.P.reduce((s, p, a) => s + t[a] * p[j], 0));
  const resid = z.map((v, j) => v - zHat[j]);
  const t2 = t.reduce((s, ti, a) => s + (ti * ti) / model.lambda[a], 0);
  const q = resid.reduce((s, r) => s + r * r, 0);
  return { z, t, resid, t2, q };
}

function evaluate(model: PcaModel, x: number[], ts: number): AnomalyResult {
  const { z, t, resid, t2, q } = scores(model, x);
  const t2Ratio = t2 / model.t2Limit;
  const qRatio = q / model.qLimit;
  // Contributions to whichever statistic is further out of bounds
  let raw: number[];
  if (qRatio >= t2Ratio) {
    raw = resid.map((r) => r * r);
  } else {
    raw = z.map((zj, j) => Math.max(0, model.P.reduce((s, p, a) => s + (t[a] / model.lambda[a]) * p[j] * zj, 0)));
  }
  const total = raw.reduce((a, b) => a + b, 0) || 1;
  const contributions = raw
    .map((v, j) => ({ feature: j, name: FEATURES[j].name, asset: FEATURES[j].asset, share: v / total }))
    .sort((a, b) => b.share - a.share);
  return { ts, t2, q, t2Ratio, qRatio, anomalous: false, contributions };
}

/** Wilson–Hilferty approximation of the χ² quantile with k degrees of freedom (z = normal quantile). */
function chi2Quantile(k: number, z: number): number {
  const a = 2 / (9 * k);
  return k * Math.pow(1 - a + z * Math.sqrt(a), 3);
}

/** Cyclic Jacobi eigen-decomposition of a symmetric matrix. Columns of `vectors` are eigenvectors. */
function jacobiEigen(A: number[][]): { values: number[]; vectors: number[][] } {
  const n = A.length;
  const a = A.map((r) => [...r]);
  const v: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off < 1e-12) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-14) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { values: a.map((r, i) => r[i]), vectors: v };
}
