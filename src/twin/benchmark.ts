/**
 * Validation benchmark. Runs the real twin pipeline (shadow model, supervisor, learned anomaly
 * model) against headless copies of the plant with randomised faults, and measures:
 *   detection rate · time to detect · diagnosis accuracy (confusion matrix) · false alarms per hour.
 */
import { Plant } from '../plant/model';
import type { PlantFrame } from '../bus/protocol';
import { AlarmManager } from './alarms';
import { AnomalyDetector } from './anomaly';
import { FeatureExtractor } from './features';
import { ShadowModel } from './shadow';
import { Supervisor } from './supervisor';

export type FaultCase = 'slip' | 'jam' | 'sensor' | 'wear' | 'rub';
export type Diagnosis = FaultCase | 'none';

export const FAULT_LABEL: Record<Diagnosis, string> = {
  slip: 'Belt slip',
  jam: 'Jam',
  sensor: 'Photo-eye failure',
  wear: 'Bearing wear',
  rub: 'Guide rub (unmodelled)',
  none: 'Not diagnosed',
};

export const FAULT_CASES: FaultCase[] = ['slip', 'jam', 'sensor', 'wear', 'rub'];
export const DIAGNOSES: Diagnosis[] = [...FAULT_CASES, 'none'];

/** Rule-based alarm id → diagnosis (guide rub has no rule: that is the point of the learned model). */
function diagnosisOf(alarmId: string): FaultCase | null {
  if (alarmId === 'BELT.SLIP') return 'slip';
  if (alarmId.startsWith('JAM.')) return 'jam';
  if (alarmId.endsWith('.FAULT') && alarmId.startsWith('PE')) return 'sensor';
  if (alarmId === 'M001.LOAD') return 'wear';
  return null;
}

export interface RunResult {
  fault: FaultCase;
  ruleS: number | null;
  diagnosis: Diagnosis;
  learnedS: number | null;
}

export interface FaultRow {
  fault: FaultCase;
  runs: number;
  ruleDetected: number;
  ruleMeanS: number | null;
  ruleMinS: number | null;
  ruleMaxS: number | null;
  correct: number;
  learnedDetected: number;
  learnedMeanS: number | null;
}

export interface BenchmarkReport {
  runsPerFault: number;
  rows: FaultRow[];
  confusion: Record<FaultCase, Record<Diagnosis, number>>;
  falseAlarms: { rules: number; learned: number; hours: number };
  simSeconds: number;
  wallMs: number;
}

const SCAN = 0.02;
const WATCH_S = 45; // observation window after the fault is injected

interface Harness {
  plant: Plant;
  alarms: AlarmManager;
  shadow: ShadowModel;
  supervisor: Supervisor;
  features: FeatureExtractor;
  anomaly: AnomalyDetector;
  ts: number;
  seq: number;
  simS: number;
}

function makeHarness(seed: number, speed: number): Harness {
  const plant = new Plant({ seed, autoInspectAccuracy: 0.99 });
  const alarms = new AlarmManager();
  const shadow = new ShadowModel();
  const link = { call: (m: string, ...a: unknown[]) => Promise.resolve(plant.call(m, a)), connected: true, frame: null };
  const supervisor = new Supervisor(link, alarms, shadow);
  plant.call('SetSpeed', [speed]);
  plant.call('Reset');
  for (let i = 0; i < 40; i++) plant.step(SCAN);
  plant.call('Start');
  return { plant, alarms, shadow, supervisor, features: new FeatureExtractor(), anomaly: new AnomalyDetector(), ts: 1_000_000, seq: 0, simS: 0 };
}

/** Advances the plant by `seconds`, feeding the twin at 25 Hz like the live link. */
function advance(h: Harness, seconds: number, onFrame: (h: Harness) => boolean | void): void {
  const scans = Math.round(seconds / SCAN);
  for (let i = 0; i < scans; i++) {
    h.plant.step(SCAN);
    h.ts += SCAN * 1000;
    h.simS += SCAN;
    if (i % 2) continue;
    const f: PlantFrame = {
      type: 'frame',
      seq: ++h.seq,
      ts: h.ts,
      tags: h.plant.readTags(),
      events: h.plant.events.splice(0),
      items: [],
      pusherZ: 0,
      beltDistance: 0,
      beltSpeed: 0,
      rollerAngle: 0,
    };
    h.shadow.update(f);
    h.supervisor.evaluate(f);
    const x = h.features.update(f, h.shadow);
    if (x) h.anomaly.add(f.ts, x, Number(f.tags['Drive.SpeedSetpoint']));
    if (onFrame(h) === true) return;
  }
}

function activeDiagnoses(h: Harness): FaultCase[] {
  const out: FaultCase[] = [];
  for (const a of h.alarms.alarms.values()) {
    if (a.state === 'RTN_UNACK') continue;
    const d = diagnosisOf(a.id);
    if (d) out.push(d);
  }
  return out;
}

function inject(h: Harness, fault: FaultCase, rand: () => number): void {
  const p = h.plant;
  switch (fault) {
    case 'slip':
      p.call('SetFault', ['slip', 0.15 + rand() * 0.2]);
      break;
    case 'jam':
      p.call('SetFault', ['jam', true]);
      break;
    case 'sensor':
      p.call('SetFault', ['sensorFail', rand() < 0.5 ? 'PE201' : 'PE301']);
      break;
    case 'wear':
      p.call('SetFault', ['bearingWear', 0.5 + rand() * 0.5]);
      break;
    case 'rub':
      p.call('SetFault', ['guideRub', true]);
      break;
  }
}

/** Warm up until the learned model has a baseline for this operating mode. */
function warmUp(h: Harness): void {
  advance(h, 150, (hh) => hh.anomaly.status !== 'LEARNING' || undefined);
  advance(h, 4, () => undefined);
}

export async function runBenchmark(
  runsPerFault: number,
  onProgress?: (done: number, total: number) => void,
): Promise<BenchmarkReport> {
  const t0 = performance.now();
  let seedBase = 7001;
  const rand = mulberry(99);
  const results: RunResult[] = [];
  const total = runsPerFault * FAULT_CASES.length + 1;
  let done = 0;
  let simSeconds = 0;

  for (const fault of FAULT_CASES) {
    for (let r = 0; r < runsPerFault; r++) {
      const h = makeHarness(seedBase++, [0.25, 0.3, 0.35][r % 3]);
      warmUp(h);
      inject(h, fault, rand);
      const injectedAt = h.ts;
      let ruleS: number | null = null;
      let diagnosis: Diagnosis = 'none';
      let learnedS: number | null = null;
      advance(h, WATCH_S, (hh) => {
        if (ruleS === null) {
          const d = activeDiagnoses(hh);
          if (d.length) {
            ruleS = (hh.ts - injectedAt) / 1000;
            diagnosis = d.includes(fault) ? fault : d[0];
          }
        }
        if (learnedS === null && hh.anomaly.status === 'ANOMALY') learnedS = (hh.ts - injectedAt) / 1000;
        return ruleS !== null && learnedS !== null;
      });
      results.push({ fault, ruleS, diagnosis, learnedS });
      simSeconds += h.simS;
      onProgress?.(++done, total);
      await new Promise((res) => setTimeout(res, 0));
    }
  }

  // False alarms: healthy running after the baseline is learned
  let ruleFalse = 0;
  let learnedFalse = 0;
  let healthyS = 0;
  for (let r = 0; r < Math.max(2, Math.ceil(runsPerFault / 2)); r++) {
    const h = makeHarness(seedBase++, [0.25, 0.3, 0.35][r % 3]);
    warmUp(h);
    let ruleOn = false;
    let learnedOn = false;
    advance(h, 240, (hh) => {
      const on = activeDiagnoses(hh).length > 0;
      if (on && !ruleOn) ruleFalse++;
      ruleOn = on;
      const l = hh.anomaly.status === 'ANOMALY';
      if (l && !learnedOn) learnedFalse++;
      learnedOn = l;
    });
    healthyS += 240;
    simSeconds += h.simS;
    await new Promise((res) => setTimeout(res, 0));
  }
  onProgress?.(total, total);

  const confusion = Object.fromEntries(
    FAULT_CASES.map((f) => [f, Object.fromEntries(DIAGNOSES.map((d) => [d, 0]))]),
  ) as Record<FaultCase, Record<Diagnosis, number>>;
  for (const r of results) confusion[r.fault][r.diagnosis]++;

  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const rows: FaultRow[] = FAULT_CASES.map((fault) => {
    const rs = results.filter((r) => r.fault === fault);
    const ruleTimes = rs.filter((r) => r.ruleS !== null).map((r) => r.ruleS!);
    const learnedTimes = rs.filter((r) => r.learnedS !== null).map((r) => r.learnedS!);
    return {
      fault,
      runs: rs.length,
      ruleDetected: ruleTimes.length,
      ruleMeanS: mean(ruleTimes),
      ruleMinS: ruleTimes.length ? Math.min(...ruleTimes) : null,
      ruleMaxS: ruleTimes.length ? Math.max(...ruleTimes) : null,
      correct: rs.filter((r) => r.diagnosis === fault).length,
      learnedDetected: learnedTimes.length,
      learnedMeanS: mean(learnedTimes),
    };
  });

  return {
    runsPerFault,
    rows,
    confusion,
    falseAlarms: { rules: ruleFalse, learned: learnedFalse, hours: healthyS / 3600 },
    simSeconds,
    wallMs: performance.now() - t0,
  };
}

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
