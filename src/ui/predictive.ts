/** Health-tab panel for the learned anomaly model. */
import type { AnomalyDetector } from '../twin/anomaly';
import { TrendChart } from './trends';
import { $, escapeHtml } from './widgets';

export class AnomalyPanel {
  private readonly chart: TrendChart;

  constructor(
    private readonly anomaly: AnomalyDetector,
    onRetrain: () => void,
  ) {
    this.chart = new TrendChart($('anChart'), '', [
      { label: 'T²/limit', color: '--pen-1' },
      { label: 'Q/limit', color: '--pen-3' },
      { label: 'Limit', color: '--pen-limit', dash: [3, 3], width: 1 },
    ], [{ scale: 'r', label: '× limit', range: [0, 3] }]);
    $('anRetrain').addEventListener('click', onRetrain);
  }

  refreshTheme(): void {
    this.chart.refreshTheme();
  }

  render(): void {
    const a = this.anomaly;
    const m = a.model;
    const status = $('anStatus');
    if (a.status === 'LEARNING' || !m) {
      status.innerHTML = `<span class="spc-chip collect">LEARNING ${a.progress}/${a.trainSize}</span><span class="muted">${
        a.mode ? `learning normal behaviour at ${a.mode} m/s from 10 raw signals` : 'starts when the line runs steadily'
      }</span>`;
    } else {
      const r = a.last;
      status.innerHTML =
        `<span class="spc-chip ${a.status === 'ANOMALY' ? 'ooc' : ''}">${a.status}</span>` +
        `<span class="muted">${m.lambda.length} components · ${(m.varianceExplained * 100).toFixed(0)} % variance${
          r ? ` · T² ${r.t2Ratio.toFixed(2)}× · Q ${r.qRatio.toFixed(2)}× limit` : ''
        }</span>`;
    }
    const hist = a.history.slice(-150);
    this.chart.setData([
      hist.map((p) => p.ts / 1000),
      hist.map((p) => Math.min(3, p.t2r)),
      hist.map((p) => Math.min(3, p.qr)),
      hist.map(() => 1),
    ]);
    const r = a.last;
    $('anContrib').innerHTML =
      r && a.status !== 'LEARNING'
        ? `<p class="note">${a.status === 'ANOMALY' ? 'Signals driving the deviation:' : 'Largest contributors (within limits):'}</p>` +
          r.contributions
            .slice(0, 3)
            .map(
              (c) =>
                `<div class="face-row ${a.status === 'ANOMALY' ? 'abn' : ''}"><span>${escapeHtml(c.name)}</span><div class="bar"><div style="width:${c.share * 100}%"></div></div><b>${(c.share * 100).toFixed(0)} %</b></div>`,
            )
            .join('')
        : '';
  }
}
