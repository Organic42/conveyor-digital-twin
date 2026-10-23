/**
 * Vibration analysis for VT-001 (condition monitoring of the M-001 drive-end bearing).
 *   1. Hann window + 1024-point FFT of the acceleration block → 2.5 Hz resolution
 *   2. integrate to velocity (÷ 2πf) and compute overall RMS velocity, 10–1000 Hz
 *   3. classify severity with ISO 10816-1, class I (small machines ≤ 15 kW)
 *   4. read amplitudes at the shaft and bearing defect frequencies and diagnose
 */
import { BEARING, bearingFrequencies } from '../plant/params';
import type { VibrationBlock } from '../bus/protocol';

export interface IsoZone {
  zone: 'A' | 'B' | 'C' | 'D';
  max: number; // mm/s RMS upper bound
  text: string;
}

export const ISO_ZONES: IsoZone[] = [
  { zone: 'A', max: 0.71, text: 'newly commissioned condition' },
  { zone: 'B', max: 1.8, text: 'acceptable for unrestricted operation' },
  { zone: 'C', max: 4.5, text: 'unsatisfactory — plan maintenance' },
  { zone: 'D', max: Infinity, text: 'damage likely — stop and repair' },
];

export const ZONE_C = ISO_ZONES[1].max; // entering C = potential failure "P"
export const ZONE_D = ISO_ZONES[2].max; // entering D = functional failure "F"

export function isoZone(vRms: number): IsoZone {
  return ISO_ZONES.find((z) => vRms <= z.max)!;
}

export interface Peaks {
  x1: number; // mm/s peak at 1× shaft
  bpfo: number;
  bpfo2: number;
  bpfi: number;
}

export class VibrationAnalyzer {
  /** Velocity spectrum (mm/s peak) for display, 0–600 Hz. */
  freqs: number[] = [];
  vel: number[] = [];
  vRms = 0;
  zone: IsoZone = ISO_ZONES[0];
  shaftHz = 0;
  peaks: Peaks = { x1: 0, bpfo: 0, bpfo2: 0, bpfi: 0 };
  baselineBpfo: number | null = null;
  diagnosis = 'Waiting for the first waveform block.';
  bearingFault = false;
  /** Time the overall level first entered zone C since the last repair (P on the P-F curve). */
  pTs: number | null = null;
  readonly history: { ts: number; vRms: number; bpfo: number }[] = [];
  blocks = 0;
  private baseSamples: number[] = [];

  update(ts: number, block: VibrationBlock): void {
    const n = block.data.length;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    let wSum = 0;
    let w2Sum = 0;
    for (let i = 0; i < n; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
      re[i] = block.data[i] * w;
      wSum += w;
      w2Sum += w * w;
    }
    fft(re, im);

    const df = block.fs / n;
    const freqs: number[] = [];
    const vel: number[] = [];
    let power = 0;
    for (let k = 1; k < n / 2; k++) {
      const f = k * df;
      const mag2 = re[k] * re[k] + im[k] * im[k];
      const omega = 2 * Math.PI * f;
      if (f >= 10 && f <= 1000) power += (2 * mag2) / (n * w2Sum) / (omega * omega); // velocity² [m²/s²]
      if (f <= 600) {
        freqs.push(f);
        vel.push(((2 * Math.sqrt(mag2)) / wSum / omega) * 1000); // velocity amplitude [mm/s peak]
      }
    }
    this.blocks++;
    this.freqs = freqs;
    this.vel = vel;
    this.vRms = Math.sqrt(power) * 1000;
    this.zone = isoZone(this.vRms);
    this.shaftHz = block.rpm / 60;

    const running = this.shaftHz > 5;
    if (running) {
      const bf = bearingFrequencies(this.shaftHz);
      const at = (f: number) => {
        let m = 0;
        for (let i = 0; i < freqs.length; i++) if (Math.abs(freqs[i] - f) <= 1.5 * df) m = Math.max(m, vel[i]);
        return m;
      };
      this.peaks = { x1: at(bf.fr), bpfo: at(bf.bpfo), bpfo2: at(2 * bf.bpfo), bpfi: at(bf.bpfi) };
      if (this.baselineBpfo === null) {
        this.baseSamples.push(this.peaks.bpfo);
        if (this.baseSamples.length >= 10) this.baselineBpfo = Math.max(0.03, median(this.baseSamples));
      }
      if (this.pTs === null && this.vRms > ZONE_C) this.pTs = ts;
      this.history.push({ ts, vRms: this.vRms, bpfo: this.peaks.bpfo });
      if (this.history.length > 900) this.history.shift();
    }
    this.diagnose(running);
  }

  /** After a bearing replacement: new P-F cycle and a fresh healthy baseline. */
  reset(): void {
    this.pTs = null;
    this.history.length = 0;
    this.baselineBpfo = null;
    this.baseSamples = [];
  }

  get bpfoRatio(): number {
    return this.baselineBpfo ? this.peaks.bpfo / this.baselineBpfo : 1;
  }

  private diagnose(running: boolean): void {
    const bf = bearingFrequencies(this.shaftHz);
    if (!running) {
      this.bearingFault = false;
      this.diagnosis = 'Machine stopped — no vibration analysis.';
      return;
    }
    const ratio = this.bpfoRatio;
    this.bearingFault = this.baselineBpfo !== null && ratio > 4 && this.peaks.bpfo2 > 0.3;
    if (this.bearingFault) {
      this.diagnosis =
        `Outer-race defect on bearing ${BEARING.model}: BPFO ${bf.bpfo.toFixed(1)} Hz (${(bf.bpfo / bf.fr).toFixed(2)}× shaft) ` +
        `is ${ratio.toFixed(0)}× its baseline, with harmonics at 2× and 3× BPFO.`;
    } else if (this.zone.zone >= 'C') {
      this.diagnosis = 'High overall vibration without a bearing pattern — check unbalance, looseness or alignment.';
    } else if (this.baselineBpfo === null) {
      this.diagnosis = `Learning the healthy BPFO baseline (${this.baseSamples.length}/10 blocks).`;
    } else {
      this.diagnosis = `No bearing defect frequencies above baseline. 1× shaft ${bf.fr.toFixed(1)} Hz dominates (residual unbalance).`;
    }
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** In-place iterative radix-2 complex FFT (length must be a power of two). */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k + len / 2] = re[i + k] - ar;
        im[i + k + len / 2] = im[i + k] - ai;
        re[i + k] += ar;
        im[i + k] += ai;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}
