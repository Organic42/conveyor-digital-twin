/**
 * Feature extraction for the learned anomaly model: every 2 s, one vector describing the line's
 * condition from raw measurements only (no physics model involved).
 */
import { PackML } from '../plant/model';
import { SENSOR_IDS } from '../plant/params';
import type { PlantFrame } from '../bus/protocol';
import type { ShadowModel } from './shadow';

/** `floor` = minimum standard deviation assumed for the feature (an 80 s baseline under-estimates slow noise). */
export const FEATURES = [
  { name: 'Motor current', asset: 'M-001', floor: 0.03 },
  { name: 'PWM duty', asset: 'M-001', floor: 1.0 },
  { name: 'Belt speed (encoder)', asset: 'BELT', floor: 0.003 },
  { name: 'PE-101 occupancy', asset: 'PE-101', floor: 0.06 },
  { name: 'PE-201 occupancy', asset: 'PE-201', floor: 0.06 },
  { name: 'PE-301 occupancy', asset: 'PE-301', floor: 0.06 },
  { name: 'PE-401 occupancy', asset: 'PE-401', floor: 0.08 }, // rejects upstream make outfeed spacing irregular
  { name: 'Zone 1 transit ratio', asset: 'Zone 1', floor: 0.015 },
  { name: 'Zone 2 transit ratio', asset: 'Zone 2', floor: 0.015 },
  { name: 'Zone 3 transit ratio', asset: 'Zone 3', floor: 0.015 },
] as const;

const PERIOD = 2000; // ms between feature vectors
const OCC_WINDOW = 10_000; // ms of photo-eye history for occupancy

export class FeatureExtractor {
  private occ: { ts: number; pe: boolean[] }[] = [];
  private acc = { i: 0, duty: 0, v: 0, n: 0, start: 0 };
  private steadySince: number | null = null;

  /** Returns a feature vector every 2 s of steady running, otherwise null. */
  update(f: PlantFrame, shadow: ShadowModel): number[] | null {
    const t = f.tags;
    const steady =
      t['Status.State'] === PackML.Execute && Math.abs(Number(t['Drive.SpeedActual']) - Number(t['Drive.SpeedSetpoint'])) < 0.01;
    if (!steady) {
      this.steadySince = null;
      this.occ = [];
      this.acc = { i: 0, duty: 0, v: 0, n: 0, start: f.ts };
      return null;
    }
    this.steadySince ??= f.ts;
    this.occ.push({ ts: f.ts, pe: SENSOR_IDS.map((id) => Boolean(t[`Sensors.${id}`])) });
    while (this.occ.length && f.ts - this.occ[0].ts > OCC_WINDOW) this.occ.shift();
    this.acc.i += Number(t['Drive.MotorCurrent']);
    this.acc.duty += Number(t['Drive.Duty']);
    this.acc.v += Number(t['Drive.SpeedActual']);
    this.acc.n++;

    if (f.ts - this.acc.start < PERIOD) return null;
    const a = this.acc;
    this.acc = { i: 0, duty: 0, v: 0, n: 0, start: f.ts };
    if (f.ts - this.steadySince < OCC_WINDOW || a.n < 20) return null;
    const occupancy = SENSOR_IDS.map((_, k) => this.occ.filter((s) => s.pe[k]).length / this.occ.length);
    return [a.i / a.n, a.duty / a.n, a.v / a.n, ...occupancy, shadow.zoneRatio[1], shadow.zoneRatio[2], shadow.zoneRatio[3]];
  }
}
