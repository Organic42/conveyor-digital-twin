/**
 * 2D line overview — the classic HMI schematic of the conveyor: zones, photo-eyes, stations,
 * plant cartons (filled) and the twin's carton estimates (outlined), drawn to scale.
 */
import { GEOMETRY as G, SENSOR_IDS, SENSOR_LABEL, SENSOR_X } from '../plant/params';
import type { PlantFrame } from '../bus/protocol';
import type { GhostEstimate } from '../scene/scene';
import { cssVar } from './theme';

const PAD_L = 92;
const PAD_R = 96;
const X_MAX = G.length + 0.06;

interface Palette {
  belt: string;
  carton: string;
  twin: string;
  text: string;
  sensor: string;
  station: string;
  overdue: string;
  jam: string;
  abn: string;
  on: string;
}

export class LineOverview {
  private readonly ctx: CanvasRenderingContext2D;
  private palette!: Palette;
  private w = 0;
  private h = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.refreshTheme();
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  refreshTheme(): void {
    this.palette = {
      belt: cssVar('--ov-belt'),
      carton: cssVar('--ov-carton'),
      twin: cssVar('--ov-twin'),
      text: cssVar('--ov-text'),
      sensor: cssVar('--ov-sensor'),
      station: cssVar('--ov-station'),
      overdue: cssVar('--p2'),
      jam: cssVar('--p2'),
      abn: cssVar('--abn'),
      on: cssVar('--text'),
    };
  }

  private resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = this.canvas.clientWidth;
    this.h = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  draw(f: PlantFrame, ghosts: GhostEstimate[], jamZones: boolean[], sensorSuspect: boolean[], showTwin: boolean): void {
    const { ctx, w, h } = this;
    if (!w || !h) return;
    const p = this.palette;
    const sx = (x: number) => PAD_L + (x / X_MAX) * (w - PAD_L - PAD_R);
    const beltY = 30;
    const beltH = 14;
    const tags = f.tags;
    ctx.clearRect(0, 0, w, h);
    ctx.textBaseline = 'middle';

    // Zones
    const SX = SENSOR_IDS.map((id) => SENSOR_X[id]);
    ctx.font = '600 9.5px Segoe UI, system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (let z = 1; z <= 3; z++) {
      const x0 = sx(SX[z - 1]);
      const x1 = sx(SX[z]);
      if (jamZones[z]) {
        ctx.fillStyle = p.jam;
        ctx.globalAlpha = 0.28;
        ctx.fillRect(x0, beltY - 13, x1 - x0, beltH + 26);
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = jamZones[z] ? p.abn : p.station;
      ctx.fillText(jamZones[z] ? `ZONE ${z} · JAM` : `ZONE ${z}`, (x0 + x1) / 2, 8);
    }

    // Belt with end rollers
    ctx.fillStyle = p.belt;
    roundRect(ctx, sx(0) - 6, beltY - beltH / 2, sx(G.length) - sx(0) + 12, beltH, 7);
    ctx.fill();

    // Stations: camera above the vision photo-eye, pusher at the reject station, motor at the head
    ctx.strokeStyle = p.station;
    ctx.fillStyle = p.station;
    ctx.lineWidth = 1;
    const camX = sx(SENSOR_X.PE201 + 0.01);
    ctx.fillRect(camX - 7, beltY - 23, 14, 6);
    ctx.beginPath();
    ctx.moveTo(camX - 3, beltY - 17);
    ctx.lineTo(camX + 3, beltY - 17);
    ctx.lineTo(camX, beltY - 11);
    ctx.fill();
    const push = Boolean(tags['Actuators.YV301']);
    const pX = sx(G.pusherX);
    ctx.fillStyle = push ? p.on : p.station;
    ctx.fillRect(pX - 8, beltY + beltH / 2 + 3 + (push ? -3 : 0), 16, 4);
    ctx.fillRect(pX - 2, beltY + beltH / 2 + 6 + (push ? -3 : 0), 4, 6);
    ctx.beginPath();
    ctx.arc(sx(G.length) + 14, beltY, 6, 0, Math.PI * 2);
    ctx.fillStyle = p.station;
    ctx.fill();
    ctx.fillStyle = p.text;
    ctx.font = '600 8px Segoe UI, system-ui, sans-serif';
    ctx.fillText('M', sx(G.length) + 14, beltY + 0.5);

    // Plant cartons
    for (const it of f.items) {
      if (it.phase === 'falling') continue;
      const x0 = sx(it.x - G.itemLength / 2);
      const x1 = sx(it.x + G.itemLength / 2);
      const off = it.phase === 'rejecting' ? Math.min(14, (it.z / 0.15) * 14) : 0;
      ctx.fillStyle = p.carton;
      ctx.fillRect(x0, beltY - 5 + off, x1 - x0, 10);
    }

    // Twin estimates
    if (showTwin) {
      ctx.lineWidth = 1.5;
      for (const g of ghosts) {
        const x0 = sx(g.x - G.itemLength / 2);
        const x1 = sx(g.x + G.itemLength / 2);
        ctx.strokeStyle = g.overdue ? p.overdue : p.twin;
        ctx.strokeRect(x0 - 1.5, beltY - 7.5, x1 - x0 + 3, 15);
      }
    }

    // Photo-eyes
    ctx.font = '600 9px Cascadia Mono, Consolas, monospace';
    SENSOR_IDS.forEach((id, k) => {
      const x = sx(SENSOR_X[id]);
      const on = Boolean(tags[`Sensors.${id}`]);
      const bad = sensorSuspect[k];
      ctx.strokeStyle = bad ? p.abn : p.sensor;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(x, beltY - 11);
      ctx.lineTo(x, beltY + 11);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.rect(x - 3.5, beltY + 13, 7, 7);
      if (on) {
        ctx.fillStyle = bad ? p.abn : p.on;
        ctx.fill();
      }
      ctx.strokeStyle = bad ? p.abn : p.sensor;
      ctx.stroke();
      ctx.fillStyle = bad ? p.abn : p.text;
      ctx.fillText(SENSOR_LABEL[id], x, beltY + 27);
    });

    // Left caption and right-hand readouts
    ctx.textAlign = 'left';
    ctx.fillStyle = p.text;
    ctx.font = '600 10.5px Segoe UI, system-ui, sans-serif';
    ctx.fillText('CONVEYOR 01', 6, beltY - 6);
    ctx.font = '10px Cascadia Mono, Consolas, monospace';
    ctx.fillStyle = p.sensor;
    ctx.fillText(String(tags['Status.StateName'] ?? ''), 6, beltY + 8);
    ctx.textAlign = 'right';
    ctx.fillStyle = p.text;
    ctx.font = '600 11px Cascadia Mono, Consolas, monospace';
    ctx.fillText(`${Number(tags['Drive.SpeedActual'] ?? 0).toFixed(3)} m/s`, w - 4, beltY - 6);
    ctx.font = '10px Cascadia Mono, Consolas, monospace';
    ctx.fillStyle = p.sensor;
    ctx.fillText(`${ghosts.length} tracked`, w - 4, beltY + 8);
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
