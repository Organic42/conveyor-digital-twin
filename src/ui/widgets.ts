/** Small DOM widgets in the ISA-101 high-performance HMI style. */

export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

export const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)} %`;

export const hhmmss = (ts: number) =>
  new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export interface IndicatorSpec {
  label: string;
  unit: string;
  min: number;
  max: number;
  normal: [number, number];
  hi?: number;
  hihi?: number;
  decimals: number;
}

/**
 * Moving analog indicator: value on a grey scale with the normal operating band shown lighter.
 * Colour appears only when the value leaves the normal band (amber) or crosses a high-high limit (red).
 */
export class AnalogIndicator {
  private readonly root: HTMLElement;
  private readonly val: HTMLElement;
  private readonly ptr: HTMLElement;
  private readonly sp: HTMLElement;

  constructor(
    host: HTMLElement,
    private readonly spec: IndicatorSpec,
  ) {
    const pos = (v: number) => `${((v - spec.min) / (spec.max - spec.min)) * 100}%`;
    this.root = document.createElement('div');
    this.root.className = 'ai';
    this.root.innerHTML = `
      <div class="ai-top"><span class="ai-label">${spec.label}</span><span class="ai-val"><b>—</b> ${spec.unit}</span></div>
      <div class="ai-scale">
        <div class="ai-normal" style="left:${pos(spec.normal[0])};width:calc(${pos(spec.normal[1])} - ${pos(spec.normal[0])})"></div>
        ${spec.hi !== undefined ? `<div class="ai-limit" style="left:${pos(spec.hi)}"></div>` : ''}
        ${spec.hihi !== undefined ? `<div class="ai-limit hh" style="left:${pos(spec.hihi)}"></div>` : ''}
        <div class="ai-sp" hidden></div>
        <div class="ai-ptr"></div>
      </div>
      <div class="ai-range"><span>${spec.min}</span><span>${spec.max}</span></div>`;
    host.appendChild(this.root);
    this.val = this.root.querySelector('.ai-val b')!;
    this.ptr = this.root.querySelector('.ai-ptr')!;
    this.sp = this.root.querySelector('.ai-sp')!;
  }

  set(v: number, setpoint?: number): void {
    const s = this.spec;
    const frac = (x: number) => Math.min(1, Math.max(0, (x - s.min) / (s.max - s.min))) * 100;
    this.val.textContent = Number.isFinite(v) ? v.toFixed(s.decimals) : '—';
    this.ptr.style.left = `${frac(v)}%`;
    if (setpoint !== undefined) {
      this.sp.hidden = false;
      this.sp.style.left = `${frac(setpoint)}%`;
    }
    const hihi = s.hihi !== undefined && v >= s.hihi;
    const hi = !hihi && s.hi !== undefined && v >= s.hi;
    this.root.classList.toggle('abn-hi', hi);
    this.root.classList.toggle('abn-hihi', hihi);
  }
}

export function toast(text: string, kind: 'info' | 'bad' = 'info'): void {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  host.appendChild(el);
  setTimeout(() => el.classList.add('out'), 3200);
  setTimeout(() => el.remove(), 3700);
}

/** Wires every [data-tab-scope] container: nav buttons [data-tab] switch panes [data-pane]. */
export function bindTabs(onChange?: (tab: string) => void): void {
  document.querySelectorAll<HTMLElement>('[data-tab-scope]').forEach((scope) => {
    const buttons = scope.querySelectorAll<HTMLButtonElement>('nav [data-tab]');
    buttons.forEach((b) =>
      b.addEventListener('click', () => {
        buttons.forEach((x) => x.classList.toggle('on', x === b));
        scope
          .querySelectorAll<HTMLElement>(':scope [data-pane]')
          .forEach((p) => p.classList.toggle('on', p.dataset.pane === b.dataset.tab));
        onChange?.(b.dataset.tab!);
      }),
    );
  });
}

export function download(filename: string, text: string, type = 'text/csv'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
