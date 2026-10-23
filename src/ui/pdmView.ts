/** Predictive-maintenance tab: bearing condition, spectrum, P-F curve with RUL, strategy economics. */
import { bearingFrequencies } from '../plant/params';
import { compareStrategies, DEFAULT_ECON, type EconInputs } from '../twin/economics';
import type { RulEstimate, RulEstimator } from '../twin/rul';
import { fmtDuration } from '../twin/supervisor';
import { ISO_ZONES, ZONE_C, ZONE_D, type VibrationAnalyzer } from '../twin/vibration';
import { TrendChart, type Series, type VLine } from './trends';
import { $, escapeHtml, hhmmss } from './widgets';

const ISO_SCALE_MAX = 7; // mm/s shown on the severity bar
const inr = (v: number) => `₹ ${Math.round(v).toLocaleString('en-IN')}`;

export class PdmView {
  private readonly spectrum: TrendChart;
  private readonly pf: TrendChart;
  private lastBlock = -1;

  constructor(
    private readonly vib: VibrationAnalyzer,
    private readonly rul: RulEstimator,
  ) {
    this.spectrum = new TrendChart(
      $('specChart'),
      '',
      [{ label: 'Velocity', color: '--pen-1', width: 1.2, decimals: 2 }],
      [{ scale: 'v', label: 'mm/s pk' }],
      false,
      () => this.markers(),
    );
    this.pf = new TrendChart($('rulChart'), '', [
      { label: 'Velocity RMS', color: '--pen-1', decimals: 2 },
      { label: 'Projection', color: '--pen-2', dash: [5, 4], decimals: 2 },
      { label: 'P (zone C)', color: '--p2', dash: [3, 3], width: 1, decimals: 2 },
      { label: 'F (zone D)', color: '--pen-limit', dash: [3, 3], width: 1, decimals: 2 },
    ], [{ scale: 'v', label: 'mm/s', range: [0, ISO_SCALE_MAX] }]);
    this.buildIsoScale();
    for (const id of ['ecDown', 'ecPart', 'ecLife', 'ecDetect']) $(id).addEventListener('input', () => this.renderEconomics());
    this.renderEconomics();
  }

  refreshTheme(): void {
    this.spectrum.refreshTheme();
    this.pf.refreshTheme();
  }

  /** Called by the benchmark: use its measured wear-detection rate in the economics. */
  setDetectionRate(rate: number): void {
    $<HTMLInputElement>('ecDetect').value = String(Math.round(rate * 100));
    this.renderEconomics();
  }

  private markers(): VLine[] {
    if (this.vib.shaftHz < 5) return [];
    const bf = bearingFrequencies(this.vib.shaftHz);
    return [
      { x: bf.fr, label: '1×', color: '--pen-ref' },
      { x: bf.bpfo, label: 'BPFO', color: '--p2' },
      { x: 2 * bf.bpfo, label: '2×BPFO', color: '--p2' },
      { x: 3 * bf.bpfo, label: '3×', color: '--p2' },
      { x: bf.bpfi, label: 'BPFI', color: '--pen-3' },
    ];
  }

  private buildIsoScale(): void {
    let from = 0;
    $('isoScale').innerHTML =
      '<div class="iso-bar">' +
      ISO_ZONES.map((z) => {
        const to = Math.min(z.max, ISO_SCALE_MAX);
        const seg = `<div class="iso-seg z${z.zone}" style="width:${((to - from) / ISO_SCALE_MAX) * 100}%" title="Zone ${z.zone}: ${z.text}"><span>${z.zone}</span></div>`;
        from = to;
        return seg;
      }).join('') +
      '<div class="iso-ptr" id="isoPtr"></div></div><div class="iso-ticks"><span>0</span><span style="left:10.1%">0.71</span><span style="left:25.7%">1.8</span><span style="left:64.3%">4.5</span><span style="left:100%">7 mm/s</span></div>';
  }

  /** Returns the RUL estimate; draws the tab only when `draw` is true. */
  render(draw: boolean): RulEstimate {
    const v = this.vib;
    const est = this.rul.estimate();
    if (!draw) return est;

    $('isoPtr').style.left = `${(Math.min(v.vRms, ISO_SCALE_MAX) / ISO_SCALE_MAX) * 100}%`;
    const bf = bearingFrequencies(Math.max(v.shaftHz, 0.001));
    $('vibMetrics').innerHTML = [
      ['Overall velocity (RMS)', `${v.vRms.toFixed(2)} mm/s · zone ${v.zone.zone}`, v.zone.zone >= 'C'],
      ['BPFO amplitude', `${v.peaks.bpfo.toFixed(2)} mm/s · ${v.bpfoRatio.toFixed(1)}× base`, v.bearingFault],
      ['Shaft speed', `${v.shaftHz.toFixed(1)} Hz · ${(v.shaftHz * 60).toFixed(0)} rpm`, false],
      ['BPFO / BPFI', v.shaftHz > 5 ? `${bf.bpfo.toFixed(1)} / ${bf.bpfi.toFixed(1)} Hz` : '—', false],
    ]
      .map(([k, val, abn]) => `<div class="metric"><span>${k}</span><b class="${abn ? 'abn' : ''}">${val}</b></div>`)
      .join('');
    const diag = $('vibDiag');
    diag.className = `advisory ${v.bearingFault || v.zone.zone >= 'C' ? 'abn' : ''}`;
    diag.textContent = `Zone ${v.zone.zone} — ${v.zone.text}. ${v.diagnosis}`;

    if (v.blocks !== this.lastBlock) {
      this.lastBlock = v.blocks;
      this.spectrum.setData([v.freqs, v.vel]);
      $('specFreqs').textContent =
        v.shaftHz > 5
          ? `1× ${bf.fr.toFixed(1)} Hz · BPFO ${bf.bpfo.toFixed(1)} Hz (${(bf.bpfo / bf.fr).toFixed(2)}×) · BPFI ${bf.bpfi.toFixed(1)} Hz (${(bf.bpfi / bf.fr).toFixed(2)}×) · BSF ${bf.bsf.toFixed(1)} Hz · FTF ${bf.ftf.toFixed(1)} Hz`
          : 'Machine stopped.';
    }

    // P-F curve and RUL
    const rulVal = $('rulVal');
    rulVal.textContent = est.rulS === 0 ? 'failure level' : est.rulS !== null ? fmtDuration(est.rulS) : 'no trend';
    rulVal.classList.toggle('abn', est.rulS !== null && est.rulS < 180);
    $('rulSlope').textContent = est.fit ? `${est.slopePerMin >= 0 ? '+' : ''}${est.slopePerMin.toFixed(2)} mm/s/min` : '—';
    $('pfP').textContent = v.pTs ? hhmmss(v.pTs) : 'not yet';
    $('pfP').classList.toggle('abn', v.pTs !== null);
    const nowS = Date.now();
    $('pfInt').textContent = v.pTs && est.rulS !== null ? fmtDuration((nowS + est.rulS * 1000 - v.pTs) / 1000) : '—';
    $('rulNote').textContent =
      est.rulS === null
        ? `Vibration stable — no degradation trend. P = entering zone C (${ZONE_C} mm/s), F = zone D (${ZONE_D} mm/s).`
        : est.rulS === 0
          ? 'Functional failure level reached — stop and replace the bearing.'
          : `Linear trend over the last minute predicts F in ${fmtDuration(est.rulS)} (band ${est.lowS !== null ? fmtDuration(est.lowS) : '—'} – ${est.highS !== null ? fmtDuration(est.highS) : 'longer'}). Time is demo-accelerated.`;

    const hist = this.rul.history.slice(-240);
    const t: number[] = hist.map(([ts]) => ts);
    const val: Series = hist.map(([, x]) => x);
    const proj: Series = hist.map(() => null);
    if (est.fit && est.rulS !== null && est.rulS > 0 && hist.length) {
      const last = hist[hist.length - 1][0];
      const end = last + Math.min(est.rulS, 600);
      proj[hist.length - 1] = val[hist.length - 1];
      for (let k = 1; k <= 20; k++) {
        const ts = last + ((end - last) * k) / 20;
        t.push(ts);
        val.push(null);
        proj.push(est.fit.a + est.fit.b * (ts - est.fit.t0));
      }
    }
    this.pf.setData([t, val, proj, t.map(() => ZONE_C), t.map(() => ZONE_D)]);
    return est;
  }

  private renderEconomics(): void {
    const num = (id: string, d: number) => {
      const v = Number($<HTMLInputElement>(id).value);
      return Number.isFinite(v) && v >= 0 ? v : d;
    };
    const x: EconInputs = {
      ...DEFAULT_ECON,
      downtimePerMin: num('ecDown', DEFAULT_ECON.downtimePerMin),
      partCost: num('ecPart', DEFAULT_ECON.partCost),
      meanLifeH: Math.max(100, num('ecLife', DEFAULT_ECON.meanLifeH)),
      detectionRate: Math.min(1, num('ecDetect', 98) / 100),
    };
    const rows = compareStrategies(x);
    const reactive = rows[0].annualCost;
    const best = rows.reduce((a, b) => (b.annualCost < a.annualCost ? b : a));
    const maxCost = Math.max(...rows.map((r) => r.annualCost));
    $('econTable').innerHTML =
      '<thead><tr><th>Strategy</th><th>Jobs / yr</th><th>Breakdowns / yr</th><th>Cost / yr</th></tr></thead><tbody>' +
      rows
        .map(
          (r) => `<tr class="${r === best ? 'best' : ''}"><th>${escapeHtml(r.name)}<div class="econ-bar"><div style="width:${(r.annualCost / maxCost) * 100}%"></div></div><i>${escapeHtml(r.note)}</i></th>
            <td>${r.replacementsPerYear.toFixed(2)}</td><td>${r.failuresPerYear.toFixed(2)}</td><td class="${r === best ? 'better' : ''}">${inr(r.annualCost)}</td></tr>`,
        )
        .join('') +
      '</tbody>';
    const pdm = rows[2];
    $('econNote').textContent =
      `Predictive maintenance saves ${inr(reactive - pdm.annualCost)} per year per bearing position vs run-to-failure ` +
      `(${(((reactive - pdm.annualCost) / reactive) * 100).toFixed(0)} %) and ${inr(rows[1].annualCost - pdm.annualCost)} vs time-based replacement. ` +
      `Assumes ${x.hoursPerYear} h/yr, Weibull β = 2 wear-out, breakdown = 3 h stop + ${inr(x.collateral)} secondary damage, planned job = 30 min.`;
  }
}
