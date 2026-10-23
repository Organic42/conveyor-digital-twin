/**
 * Maintenance strategy economics for one bearing position — run-to-failure vs time-based
 * replacement vs condition-based (predictive) replacement.
 *
 * Bearing life follows a Weibull wear-out distribution (shape β = 2). Preventive replacement at
 * a fixed age T; predictive replacement when the twin detects the P point, with a detection rate
 * taken from the validation benchmark.
 */

export interface EconInputs {
  downtimePerMin: number; // ₹ of lost production per minute of stoppage
  partCost: number; // ₹ bearing + seals
  labourPerHour: number; // ₹
  meanLifeH: number; // mean bearing life [h]
  hoursPerYear: number; // operating hours
  collateral: number; // ₹ secondary damage when a bearing fails in service (shaft, gearbox, motor)
  monitoringPerYear: number; // ₹ sensor + gateway amortisation
  detectionRate: number; // share of degradations the twin catches before failure
}

export const DEFAULT_ECON: EconInputs = {
  downtimePerMin: 500,
  partCost: 1200,
  labourPerHour: 400,
  meanLifeH: 4000,
  hoursPerYear: 6000,
  collateral: 8000,
  monitoringPerYear: 6000,
  detectionRate: 0.98,
};

const BETA = 2;
const UNPLANNED_DOWNTIME_MIN = 180; // breakdown: diagnose, fetch parts, repair, collateral work
const UNPLANNED_LABOUR_H = 4;
const PLANNED_DOWNTIME_MIN = 30; // planned job in a scheduled stop, parts ready
const PLANNED_LABOUR_H = 1;
const PREVENTIVE_AGE = 0.5; // replace at 50 % of mean life
const PREDICTIVE_USE = 0.9; // on average 90 % of each bearing's life is used before P triggers replacement

export interface StrategyResult {
  name: string;
  replacementsPerYear: number;
  failuresPerYear: number;
  annualCost: number;
  note: string;
}

export function compareStrategies(x: EconInputs): StrategyResult[] {
  const eta = x.meanLifeH / gamma(1 + 1 / BETA);
  const R = (t: number) => Math.exp(-Math.pow(t / eta, BETA));
  const failureCost = x.partCost + x.labourPerHour * UNPLANNED_LABOUR_H + x.downtimePerMin * UNPLANNED_DOWNTIME_MIN + x.collateral;
  const plannedCost = x.partCost + x.labourPerHour * PLANNED_LABOUR_H + x.downtimePerMin * PLANNED_DOWNTIME_MIN;

  // Run to failure
  const reactiveFailures = x.hoursPerYear / x.meanLifeH;

  // Age-based replacement at T: renewal cycle = E[min(life, T)]
  const T = PREVENTIVE_AGE * x.meanLifeH;
  let cycle = 0;
  const steps = 400;
  for (let i = 0; i < steps; i++) cycle += R(((i + 0.5) * T) / steps) * (T / steps);
  const pFailBeforeT = 1 - R(T);
  const pmRenewals = x.hoursPerYear / cycle;

  // Condition-based replacement
  const pdmRenewals = x.hoursPerYear / (PREDICTIVE_USE * x.meanLifeH);

  return [
    {
      name: 'Reactive (run to failure)',
      replacementsPerYear: reactiveFailures,
      failuresPerYear: reactiveFailures,
      annualCost: reactiveFailures * failureCost,
      note: 'every replacement is a breakdown with secondary damage',
    },
    {
      name: `Preventive (replace every ${Math.round(T)} h)`,
      replacementsPerYear: pmRenewals,
      failuresPerYear: pmRenewals * pFailBeforeT,
      annualCost: pmRenewals * (pFailBeforeT * failureCost + (1 - pFailBeforeT) * plannedCost),
      note: `${(pFailBeforeT * 100).toFixed(0)} % still fail early; good bearings are discarded at half life`,
    },
    {
      name: 'Predictive (this digital twin)',
      replacementsPerYear: pdmRenewals,
      failuresPerYear: pdmRenewals * (1 - x.detectionRate),
      annualCost:
        pdmRenewals * (x.detectionRate * plannedCost + (1 - x.detectionRate) * failureCost) + x.monitoringPerYear,
      note: `replaced at the P point; ${(x.detectionRate * 100).toFixed(0)} % detection, plus monitoring cost`,
    },
  ];
}

/** Lanczos approximation of Γ(z). */
function gamma(z: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gamma(1 - z));
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
}
