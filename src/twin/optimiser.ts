/**
 * Setpoint optimiser: sweeps the speed range with the what-if engine and picks the speed that
 * maximises the chosen objective while keeping the motor safe (no trip, peak winding < 80 °C).
 */
import { DRIVE, THERMAL } from '../plant/params';
import { runScenario, type Scenario, type ScenarioResult } from './whatif';

export type Objective = 'throughput' | 'energy' | 'oee';

export const OBJECTIVE_LABEL: Record<Objective, string> = {
  throughput: 'Max good cartons / h',
  energy: 'Min energy per good carton',
  oee: 'Max OEE',
};

export interface OptPoint {
  speed: number;
  result: ScenarioResult;
  feasible: boolean;
  why: string;
}

export interface OptResult {
  objective: Objective;
  points: OptPoint[];
  best: OptPoint | null;
  wallMs: number;
}

export function score(objective: Objective, r: ScenarioResult): number {
  if (objective === 'throughput') return r.throughputPerH;
  if (objective === 'oee') return r.oee;
  return r.energyPerCartonJ !== null ? -r.energyPerCartonJ : -Infinity;
}

export async function optimise(
  base: Omit<Scenario, 'speed'>,
  objective: Objective,
  onProgress?: (done: number, total: number) => void,
): Promise<OptResult> {
  const t0 = performance.now();
  const speeds: number[] = [];
  for (let v = 0.15; v <= DRIVE.maxSpeed + 1e-9; v += 0.02) speeds.push(Math.round(v * 100) / 100);
  const points: OptPoint[] = [];
  for (const speed of speeds) {
    const result = runScenario({ ...base, speed });
    const trip = result.tripAtMin !== null;
    const hot = result.peakTemp >= THERMAL.highAlarm;
    points.push({
      speed,
      result,
      feasible: !trip && !hot,
      why: trip ? `trips after ${result.tripAtMin!.toFixed(1)} min` : hot ? `peak ${result.peakTemp.toFixed(0)} °C ≥ ${THERMAL.highAlarm} °C` : 'safe',
    });
    onProgress?.(points.length, speeds.length);
    await new Promise((r) => setTimeout(r, 0));
  }
  const feasible = points.filter((p) => p.feasible);
  const best = feasible.length ? feasible.reduce((a, b) => (score(objective, b.result) > score(objective, a.result) ? b : a)) : null;
  return { objective, points, best, wallMs: performance.now() - t0 };
}
