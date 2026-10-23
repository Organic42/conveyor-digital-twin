import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { cssVar } from './theme';

export interface Pen {
  label: string;
  /** A colour, or a CSS custom property name such as '--pen-1' (resolved per theme). */
  color: string;
  scale?: string;
  dash?: number[];
  width?: number;
  decimals?: number;
  /** Draw sample markers on the line. */
  markers?: boolean;
  /** Markers only, no connecting line (e.g. SPC rule violations). */
  pointsOnly?: boolean;
}

export interface AxisSpec {
  scale: string;
  label: string;
  side?: 'left' | 'right';
  range?: [number, number];
}

export type Series = (number | null)[];

const resolve = (c: string) => (c.startsWith('--') ? cssVar(c) : c);
const FONT = '10px Segoe UI, system-ui, sans-serif';

/** Thin wrapper around uPlot that keeps the chart sized to its container and follows the theme. */
export class TrendChart {
  private plot!: uPlot;
  private data: Series[];

  constructor(
    private readonly host: HTMLElement,
    private readonly title: string,
    private readonly pens: Pen[],
    private readonly axes: AxisSpec[],
    private readonly xTime = true,
  ) {
    this.data = [[], ...pens.map(() => [])];
    this.build();
    new ResizeObserver(() => this.fit()).observe(host);
  }

  private build(): void {
    const axisStroke = cssVar('--chart-axis');
    const gridStroke = cssVar('--chart-grid');
    const base = { stroke: axisStroke, grid: { stroke: gridStroke, width: 1 }, ticks: { stroke: gridStroke, width: 1 }, font: FONT };
    const scales: uPlot.Scales = { x: { time: this.xTime } };
    for (const a of this.axes) scales[a.scale] = a.range ? { range: a.range } : { auto: true };

    const series: uPlot.Series[] = this.pens.map((p) => {
      const color = resolve(p.color);
      const s: uPlot.Series = {
        label: p.label,
        stroke: color,
        width: p.width ?? 1.6,
        dash: p.dash,
        scale: p.scale ?? this.axes[0].scale,
        points: { show: !!(p.markers || p.pointsOnly), size: p.pointsOnly ? 8 : 4, fill: color, stroke: color },
        value: (_u, v) => (v == null ? '—' : v.toFixed(p.decimals ?? 2)),
      };
      if (p.pointsOnly) s.paths = () => null;
      return s;
    });

    const opts: uPlot.Options = {
      title: this.title,
      width: Math.max(200, this.host.clientWidth),
      height: Math.max(80, this.host.clientHeight - 40),
      pxAlign: false,
      cursor: { drag: { x: false, y: false }, points: { size: 5 } },
      legend: { live: true },
      scales,
      series: [{ value: this.xTime ? undefined : (_u, v) => (v == null ? '—' : String(v)) }, ...series],
      axes: [
        { ...base, size: 26 },
        ...this.axes.map(
          (a, i): uPlot.Axis => ({
            ...base,
            scale: a.scale,
            label: a.label,
            side: a.side === 'right' ? 1 : 3,
            grid: i === 0 ? base.grid : { show: false },
            size: 42,
            labelSize: 14,
            labelFont: FONT,
          }),
        ),
      ],
    };
    this.plot = new uPlot(opts, this.data as uPlot.AlignedData, this.host);
    this.fit();
    setTimeout(() => this.fit()); // legend height is only final after layout
  }

  private fit(): void {
    const root = this.plot.root;
    const legend = (root.querySelector('.u-legend') as HTMLElement | null)?.offsetHeight ?? 0;
    const titleH = (root.querySelector('.u-title') as HTMLElement | null)?.offsetHeight ?? 0;
    this.plot.setSize({
      width: Math.max(200, this.host.clientWidth),
      height: Math.max(60, this.host.clientHeight - legend - titleH),
    });
  }

  setData(data: Series[]): void {
    this.data = data;
    this.plot.setData(data as uPlot.AlignedData);
  }

  /** Re-creates the chart with the current theme colours, keeping its data. */
  refreshTheme(): void {
    this.plot.destroy();
    this.build();
  }
}
