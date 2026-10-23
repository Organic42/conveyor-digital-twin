/**
 * What-if engine: runs a private copy of the plant model headless, much faster than real time,
 * from the current machine condition, so a setpoint change can be evaluated before it is applied.
 */
import { IDEAL_CYCLE } from '../plant/params';
import { PackML, Plant } from '../plant/model';
import { CONTROL_POWER_W, drivePower } from './energy';

export interface Scenario {
  speed: number;
  horizonMin: number;
  temperature: number;
  wear: number;
  slip: number;
  defectRate: number;
}

export interface ScenarioResult {
  speed: number;
  throughputPerH: number;
  good: number;
  rejected: number;
  availability: number;
  performance: number;
  quality: number;
  oee: number;
  peakTemp: number;
  finalTemp: number;
  tripAtMin: number | null;
  energyPerCartonJ: number | null;
  temps: [number[], number[]]; // minutes, °C
  wallMs: number;
}

const DT = 0.02;

export function runScenario(sc: Scenario): ScenarioResult {
  const t0 = performance.now();
  const plant = new Plant({ seed: 4242, autoInspectAccuracy: 0.985 });
  plant.setCondition({ temperature: sc.temperature, wear: sc.wear, slip: sc.slip });
  plant.faults.defectRate = sc.defectRate;
  plant.call('SetSpeed', [sc.speed]);
  plant.call('Reset');
  for (let i = 0; i < 50 && plant.state !== PackML.Idle; i++) plant.step(DT);
  plant.call('Start');

  const steps = Math.round((sc.horizonMin * 60) / DT);
  const sampleEvery = Math.round(10 / DT);
  const mins: number[] = [];
  const temps: number[] = [];
  let run = 0;
  let peak = plant.temperature;
  let tripAt: number | null = null;
  let energyJ = 0;

  for (let i = 0; i < steps; i++) {
    plant.step(DT);
    energyJ += (drivePower(plant.duty * 100, plant.current) + CONTROL_POWER_W) * DT;
    if (plant.state === PackML.Execute) run += DT;
    if (plant.temperature > peak) peak = plant.temperature;
    if (tripAt === null && plant.abortReason === 'OVERTEMP') tripAt = (i * DT) / 60;
    if (i % sampleEvery === 0) {
      mins.push((i * DT) / 60);
      temps.push(plant.temperature);
    }
  }

  const good = plant.counters.outfeed;
  const rejected = plant.counters.rejected;
  const total = good + rejected;
  const planned = sc.horizonMin * 60;
  const availability = run / planned;
  const perf = run > 0 ? Math.min(1, (total * IDEAL_CYCLE) / run) : 0;
  const quality = total > 0 ? good / total : 0;
  return {
    speed: sc.speed,
    throughputPerH: (good / planned) * 3600,
    good,
    rejected,
    availability,
    performance: perf,
    quality,
    oee: availability * perf * quality,
    peakTemp: peak,
    finalTemp: plant.temperature,
    tripAtMin: tripAt,
    energyPerCartonJ: good > 0 ? energyJ / good : null,
    temps: [mins, temps],
    wallMs: performance.now() - t0,
  };
}
