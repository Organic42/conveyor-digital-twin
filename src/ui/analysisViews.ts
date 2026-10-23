/** Optimise and Validate tab views. */
import { optimise, OBJECTIVE_LABEL, type Objective, type OptResult } from '../twin/optimiser';
import { DIAGNOSES, FAULT_CASES, FAULT_LABEL, runBenchmark, type BenchmarkReport } from '../twin/benchmark';
import type { Scenario } from '../twin/whatif';
import { TrendChart } from './trends';
import { $, download, pct } from './widgets';

export class OptimiserView {
  private chart: TrendChart | null = null;
  result: OptResult | null = null;

  constructor(
    private readonly scenarioBase: () => Omit<Scenario, 'speed'> | null,
    private readonly currentSpeed: () => number,
    onApply: (speed: number) => void,
  ) {
    $('optRun').addEventListener('click', () => void this.run());
    $('optApply').addEventListener('click', () => this.result?.best && onApply(this.result.best.speed));
  }

  refreshTheme(): void {
    this.chart?.refreshTheme();
  }

  private async run(): Promise<void> {
    const base = this.scenarioBase();
    if (!base) return;
    const objective = $<HTMLSelectElement>('optObjective').value as Objective;
    const btn = $<HTMLButtonElement>('optRun');
    btn.disabled = true;
    const status = $('optStatus');
    const r = await optimise(base, objective, (done, total) => {
      status.textContent = `Simulating speed ${done}/${total} (${base.horizonMin} min each)…`;
    });
    btn.disabled = false;
    this.result = r;
    $<HTMLButtonElement>('optApply').disabled = !r.best;
    const cur = this.currentSpeed();
    const curPt = r.points.reduce((a, b) => (Math.abs(b.speed - cur) < Math.abs(a.speed - cur) ? b : a));
    if (r.best) {
      const b = r.best.result;
      const gain = curPt.result.throughputPerH > 0 ? b.throughputPerH / curPt.result.throughputPerH - 1 : 0;
      status.innerHTML =
        `<b>Optimum ${r.best.speed.toFixed(2)} m/s</b> for “${OBJECTIVE_LABEL[objective]}”: ${b.throughputPerH.toFixed(0)} good/h ` +
        `(${gain >= 0 ? '+' : ''}${pct(gain, 0)} vs ${cur.toFixed(2)} m/s), ${b.energyPerCartonJ?.toFixed(1) ?? '—'} J/carton, peak ${b.peakTemp.toFixed(1)} °C. ` +
        `${r.points.filter((p) => !p.feasible).length} speeds rejected as unsafe. ${r.points.length} runs in ${(r.wallMs / 1000).toFixed(1)} s.`;
    } else {
      status.textContent = 'No safe speed: the drive train overheats at every speed — schedule maintenance first.';
    }

    const host = $('optChart');
    host.innerHTML = '';
    this.chart = new TrendChart(
      host,
      'Speed sweep (m/s)',
      [
        { label: 'Good/h', color: '--pen-1', markers: true, decimals: 0 },
        { label: 'J/carton', color: '--pen-4', scale: 'j', decimals: 1 },
        { label: 'Unsafe', color: '--pen-limit', pointsOnly: true, decimals: 0 },
        { label: 'Optimum', color: '--pen-2', pointsOnly: true, decimals: 0 },
      ],
      [{ scale: 'th', label: 'good / h' }, { scale: 'j', label: 'J', side: 'right' }],
      false,
    );
    this.chart.setData([
      r.points.map((p) => p.speed),
      r.points.map((p) => p.result.throughputPerH),
      r.points.map((p) => p.result.energyPerCartonJ),
      r.points.map((p) => (p.feasible ? null : p.result.throughputPerH)),
      r.points.map((p) => (p === r.best ? p.result.throughputPerH : null)),
    ]);
  }
}

export class BenchmarkView {
  private report: BenchmarkReport | null = null;

  constructor(private readonly onReport: (rep: BenchmarkReport) => void) {
    $('bmRun').addEventListener('click', () => void this.run());
    $('bmExport').addEventListener('click', () => this.export());
  }

  private async run(): Promise<void> {
    const runs = Number($<HTMLSelectElement>('bmRuns').value);
    const btn = $<HTMLButtonElement>('bmRun');
    btn.disabled = true;
    const bar = $('bmBar');
    const status = $('bmStatus');
    const rep = await runBenchmark(runs, (done, total) => {
      bar.style.width = `${(done / total) * 100}%`;
      status.textContent = `Scenario ${done}/${total}…`;
    });
    btn.disabled = false;
    $<HTMLButtonElement>('bmExport').disabled = false;
    this.report = rep;
    this.onReport(rep);
    status.textContent = `${rep.rows.length * rep.runsPerFault} fault scenarios + healthy runs: ${(rep.simSeconds / 3600).toFixed(1)} h of plant time in ${(rep.wallMs / 1000).toFixed(1)} s (${Math.round((rep.simSeconds * 1000) / rep.wallMs)}× real time).`;
    this.render(rep);
  }

  private render(rep: BenchmarkReport): void {
    const s = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)} s`);
    $('bmTable').innerHTML =
      '<thead><tr><th>Fault</th><th>Rules detect</th><th>Mean (min–max)</th><th>Correct diagnosis</th><th>Learned model</th></tr></thead><tbody>' +
      rep.rows
        .map(
          (r) => `<tr><th>${FAULT_LABEL[r.fault]}</th>
            <td class="${r.ruleDetected < r.runs ? 'abn' : ''}">${r.ruleDetected}/${r.runs}</td>
            <td>${s(r.ruleMeanS)}${r.ruleMinS !== null ? ` <span class="muted">(${r.ruleMinS.toFixed(1)}–${r.ruleMaxS!.toFixed(1)})</span>` : ''}</td>
            <td class="${r.correct < r.runs ? 'abn' : ''}">${pct(r.correct / r.runs, 0)}</td>
            <td>${r.learnedDetected}/${r.runs}${r.learnedMeanS !== null ? ` · ${s(r.learnedMeanS)}` : ''}</td></tr>`,
        )
        .join('') +
      '</tbody>';
    $('bmConfusion').innerHTML =
      `<thead><tr><th></th>${DIAGNOSES.map((d) => `<th>${FAULT_LABEL[d].split(' (')[0]}</th>`).join('')}</tr></thead><tbody>` +
      FAULT_CASES.map(
        (f) =>
          `<tr><th>${FAULT_LABEL[f]}</th>${DIAGNOSES.map((d) => {
            const n = rep.confusion[f][d];
            return `<td class="${n ? (d === f ? 'hit' : 'miss') : ''}">${n || ''}</td>`;
          }).join('')}</tr>`,
      ).join('') +
      '</tbody>';
    const fa = rep.falseAlarms;
    $('bmFalse').innerHTML = [
      ['Healthy running observed', `${(fa.hours * 60).toFixed(0)} min`],
      ['Rule-based false alarms', `${fa.rules} (${(fa.rules / fa.hours).toFixed(1)} /h)`],
      ['Learned-model false alarms', `${fa.learned} (${(fa.learned / fa.hours).toFixed(1)} /h)`],
    ]
      .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
      .join('');
  }

  private export(): void {
    const rep = this.report;
    if (!rep) return;
    const lines = [
      'Conveyor 01 digital twin — validation benchmark',
      `Runs per fault,${rep.runsPerFault}`,
      `Plant time simulated [s],${rep.simSeconds.toFixed(0)}`,
      '',
      'Fault,Runs,Rules detected,Rules mean [s],Rules min [s],Rules max [s],Correct diagnosis,Learned detected,Learned mean [s]',
      ...rep.rows.map((r) =>
        [FAULT_LABEL[r.fault], r.runs, r.ruleDetected, r.ruleMeanS?.toFixed(2) ?? '', r.ruleMinS?.toFixed(2) ?? '', r.ruleMaxS?.toFixed(2) ?? '', r.correct, r.learnedDetected, r.learnedMeanS?.toFixed(2) ?? ''].join(','),
      ),
      '',
      `Injected \\ diagnosed,${DIAGNOSES.map((d) => FAULT_LABEL[d]).join(',')}`,
      ...FAULT_CASES.map((f) => `${FAULT_LABEL[f]},${DIAGNOSES.map((d) => rep.confusion[f][d]).join(',')}`),
      '',
      `Healthy hours,${rep.falseAlarms.hours.toFixed(3)}`,
      `Rule false alarms,${rep.falseAlarms.rules}`,
      `Learned false alarms,${rep.falseAlarms.learned}`,
    ];
    download('conveyor01_validation.csv', lines.join('\n'));
  }
}
