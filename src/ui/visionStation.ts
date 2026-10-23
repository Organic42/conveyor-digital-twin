/** Vision tunnel node on the HMI side: capture all cameras, classify, fuse, and report. */
import type { Verdict } from '../plant/model';
import { CAMERAS, DEFECT_KINDS, FACES, type CameraId, type DefectKind, type Face } from '../plant/params';
import type { TwinScene } from '../scene/scene';
import { fuse, inspectView, toDisplayImage, type InspectionResult } from '../twin/vision';
import { $, escapeHtml, pct } from './widgets';

export interface CameraStats {
  defects: number;
  noReads: number;
  last: Verdict | null;
}

export interface VisionStats {
  inspected: number;
  defects: number;
  noReads: number;
  msSum: number;
  perCam: Record<CameraId, CameraStats>;
  /** Rejected cartons whose defect the top camera alone would have missed. */
  missedByTop: number;
  byFace: Record<Face, number>;
  byKind: Record<DefectKind, number>;
  last: InspectionResult | null;
}

const VERDICT_CLASS: Record<Verdict, string> = { GOOD: 'v-good', DEFECT: 'v-defect', NO_READ: 'v-no_read' };
const KIND_TEXT: Record<DefectKind, string> = { label: 'Wrong label', stain: 'Ink stain' };

export class VisionStation {
  readonly enabled = new Set<CameraId>(CAMERAS.map((c) => c.id));
  readonly stats: VisionStats = {
    inspected: 0,
    defects: 0,
    noReads: 0,
    msSum: 0,
    perCam: Object.fromEntries(CAMERAS.map((c) => [c.id, { defects: 0, noReads: 0, last: null }])) as Record<CameraId, CameraStats>,
    missedByTop: 0,
    byFace: Object.fromEntries(FACES.map((f) => [f, 0])) as Record<Face, number>,
    byKind: Object.fromEntries(DEFECT_KINDS.map((k) => [k, 0])) as Record<DefectKind, number>,
    last: null,
  };
  private version = 0;
  private rendered = -1;
  private readonly camCells = new Map<CameraId, HTMLElement[]>();

  constructor(
    private readonly scene: TwinScene,
    private readonly onToggle: (camera: CameraId, enabled: boolean) => void,
  ) {
    this.buildCameraTable();
  }

  /** Captures all five cameras for the carton at PE-201 and returns the fused verdict. */
  inspect(failedCamera: string): InspectionResult {
    const t0 = performance.now();
    const { w, h } = this.scene.inspectionSize;
    const shots = this.scene.captureInspection(failedCamera).map((s) => ({ id: s.id, img: toDisplayImage(s.pixels, w, h) }));
    const views = shots.map(({ id, img }) => inspectView(img, id));
    const result = fuse(views, this.enabled, performance.now() - t0);

    const s = this.stats;
    s.inspected++;
    s.msSum += result.ms;
    s.last = result;
    for (const v of views) {
      const c = s.perCam[v.camera];
      c.last = v.verdict;
      if (v.verdict === 'DEFECT') c.defects++;
      if (v.verdict === 'NO_READ') c.noReads++;
    }
    if (result.verdict === 'DEFECT') {
      s.defects++;
      if (result.cause) {
        s.byFace[result.cause.face]++;
        if (result.cause.defectKind) s.byKind[result.cause.defectKind]++;
      }
      if (views.find((v) => v.camera === 'CAM201')?.verdict === 'GOOD') s.missedByTop++;
    }
    if (result.verdict === 'NO_READ') s.noReads++;

    this.drawMosaic(shots, result);
    this.version++;
    return result;
  }

  private drawMosaic(shots: { id: CameraId; img: ImageData }[], r: InspectionResult): void {
    for (const { id, img } of shots) {
      const canvas = document.getElementById(`cam-${id}`) as HTMLCanvasElement | null;
      if (!canvas) continue;
      const ctx = canvas.getContext('2d')!;
      ctx.putImageData(img, 0, 0);
      const view = r.views.find((v) => v.camera === id)!;
      if (view.bbox) {
        const [x0, y0, x1, y1] = view.bbox;
        ctx.strokeStyle = view.verdict === 'DEFECT' ? '#ff5a4a' : '#7fd1ff';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x0 - 1.5, y0 - 1.5, x1 - x0 + 3, y1 - y0 + 3);
      }
      const fig = canvas.parentElement!;
      fig.className = `${VERDICT_CLASS[view.verdict]} ${this.enabled.has(id) ? '' : 'off'}`;
    }
    const v = $('camVerdict');
    v.textContent = r.verdict === 'NO_READ' ? 'NO READ' : r.verdict;
    v.className = `verdict ${VERDICT_CLASS[r.verdict]}`;
    $('camReason').textContent = r.verdict === 'GOOD' ? `${(r.confidence * 100).toFixed(0)} % · accept` : 'reject';
    $('camMs').textContent = `${r.ms.toFixed(1)} ms`;
    $('camStats').textContent = `${this.stats.inspected} inspected · ${this.stats.defects} defect · ${this.stats.noReads} no-read`;
  }

  private buildCameraTable(): void {
    const table = $('camTable');
    table.innerHTML =
      '<thead><tr><th></th><th>Camera</th><th>Face</th><th>Defects</th><th>No-reads</th><th>Last</th></tr></thead><tbody>' +
      CAMERAS.map(
        (c) => `<tr data-cam="${c.id}"><td><input type="checkbox" checked aria-label="Use ${c.label}" /></td>
          <td class="mono">${c.label}</td><td>${c.view}</td><td class="mono"></td><td class="mono"></td><td class="mono"></td></tr>`,
      ).join('') +
      '</tbody>';
    table.querySelectorAll<HTMLTableRowElement>('tr[data-cam]').forEach((tr) => {
      const id = tr.dataset.cam as CameraId;
      this.camCells.set(id, [...tr.querySelectorAll<HTMLElement>('td')].slice(3));
      tr.querySelector('input')!.addEventListener('change', (e) => {
        const on = (e.target as HTMLInputElement).checked;
        if (on) this.enabled.add(id);
        else this.enabled.delete(id);
        document.querySelector(`.cam-grid figure[data-cam="${id}"]`)?.classList.toggle('off', !on);
        this.onToggle(id, on);
        this.version++;
      });
    });
  }

  /** Vision tab: refreshes only when something changed. */
  render(): void {
    if (this.rendered === this.version) return;
    this.rendered = this.version;
    const s = this.stats;

    for (const c of CAMERAS) {
      const [defects, noReads, last] = this.camCells.get(c.id)!;
      const st = s.perCam[c.id];
      defects.textContent = String(st.defects);
      noReads.textContent = String(st.noReads);
      last.textContent = st.last ?? '—';
      last.className = `mono ${st.last && st.last !== 'GOOD' ? 'abn' : ''}`;
    }

    const r = s.last;
    if (r) {
      $('visLast').innerHTML =
        `<div class="vis-verdict"><span class="verdict ${VERDICT_CLASS[r.verdict]}">${r.verdict === 'NO_READ' ? 'NO READ' : r.verdict}</span>` +
        `<span>${r.verdict === 'GOOD' ? 'Accepted' : 'Rejected'} — ${escapeHtml(r.reason)}</span></div>` +
        '<table class="cams compact"><thead><tr><th>Camera</th><th>Face</th><th>Carton</th><th>Defect area</th><th>Verdict</th></tr></thead><tbody>' +
        r.views
          .map((v) => {
            const cam = CAMERAS.find((c) => c.id === v.camera)!;
            const used = this.enabled.has(v.camera);
            return `<tr class="${used ? '' : 'dim'}"><td class="mono">${cam.label}</td><td>${v.face}</td><td class="mono">${pct(v.cartonShare, 0)}</td>
              <td class="mono">${pct(v.defectShare, 1)}${v.defectKind ? ` · ${KIND_TEXT[v.defectKind].toLowerCase()}` : ''}</td>
              <td class="mono ${v.verdict !== 'GOOD' ? 'abn' : ''}">${v.verdict}${used ? '' : ' (off)'}</td></tr>`;
          })
          .join('') +
        '</tbody></table>';
    }

    const missedShare = s.defects ? s.missedByTop / s.defects : 0;
    $('visCoverage').innerHTML = [
      ['Inspected', String(s.inspected)],
      ['Rejected as defect', String(s.defects)],
      ['Found only by side / end cameras', `${s.missedByTop} (${pct(missedShare, 0)})`],
      ['Fail-safe no-reads', String(s.noReads)],
    ]
      .map(([k, v]) => `<div class="metric"><span>${k}</span><b>${v}</b></div>`)
      .join('');
    const maxFace = Math.max(1, ...FACES.map((f) => s.byFace[f]));
    $('visFaces').innerHTML =
      `<p class="note">${s.defects ? `A top camera alone would have passed ${pct(missedShare, 0)} of the defective cartons.` : 'Defects found per carton face appear here.'}</p>` +
      FACES.map(
        (f) => `<div class="face-row"><span>${f}</span><div class="bar"><div style="width:${(s.byFace[f] / maxFace) * 100}%"></div></div><b>${s.byFace[f]}</b></div>`,
      ).join('') +
      `<p class="note">${DEFECT_KINDS.map((k) => `${KIND_TEXT[k]}: ${s.byKind[k]}`).join(' · ')}</p>`;
  }
}
