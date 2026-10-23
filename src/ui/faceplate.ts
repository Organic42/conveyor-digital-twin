/** Device faceplate shown as a popover anchored to the selected device in the 3D view. */
import { TAG_BY_PATH, formatTag } from '../bus/tags';
import type { TagValue } from '../plant/model';
import { DRIVE, SENSOR_IDS, SENSOR_LABEL, SENSOR_X, type SensorId } from '../plant/params';
import type { DeviceId } from '../scene/scene';
import type { Maintenance } from '../twin/maintenance';
import type { ShadowModel } from '../twin/shadow';
import { $, escapeHtml, pct } from './widgets';

export interface VisionStats {
  inspected: number;
  defects: number;
  noReads: number;
  msSum: number;
}

export interface FaceplateContext {
  /** Tag value of the frame currently on screen (live or replay). */
  tag(path: string): TagValue | undefined;
  shadow: ShadowModel;
  vision: VisionStats;
  maintenance: Maintenance;
  raiseWorkOrder(asset: string): void;
}

interface DeviceInfo {
  title: string;
  asset: string | null; // maintainable asset name, null if none
  kind: string;
  rows: [string, () => string][];
  note?: string;
}

const POP_W = 250;

export class FaceplatePopover {
  readonly el = $('fpPop');
  private values: HTMLElement[] = [];
  private info: DeviceInfo | null = null;
  selected: DeviceId | null = null;

  constructor(
    private readonly ctx: FaceplateContext,
    onClose: () => void,
  ) {
    $('fpClose').addEventListener('click', onClose);
    $('fpActions').addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-wo]');
      if (btn && this.info?.asset) {
        this.ctx.raiseWorkOrder(this.info.asset);
        btn.disabled = true;
        btn.textContent = 'Work order raised';
      }
    });
  }

  show(id: DeviceId | null): void {
    this.selected = id;
    if (!id) {
      this.info = null;
      this.el.hidden = true;
      return;
    }
    const info = (this.info = deviceInfo(id, this.ctx));
    $('fpTitle').textContent = info.title;
    $('fpKind').textContent = info.kind;
    $('fpRows').innerHTML = info.rows.map(([k]) => `<dt>${escapeHtml(k)}</dt><dd></dd>`).join('');
    this.values = [...$('fpRows').querySelectorAll<HTMLElement>('dd')];
    const note = $('fpNote');
    note.hidden = !info.note;
    note.textContent = info.note ?? '';
    const open = info.asset ? this.ctx.maintenance.openFor(info.asset) : 0;
    $('fpActions').innerHTML = info.asset
      ? `<button data-wo ${open ? 'disabled' : ''}>${open ? `${open} open work order${open > 1 ? 's' : ''}` : 'Raise work order'}</button>`
      : '';
    this.el.hidden = false;
    this.update();
  }

  update(): void {
    if (!this.info) return;
    this.info.rows.forEach(([, get], i) => {
      const v = get();
      if (this.values[i].textContent !== v) this.values[i].textContent = v;
    });
  }

  /** Places the popover beside the device's screen position; hides it when off-screen. */
  position(p: { x: number; y: number } | null, hostW: number, hostH: number): void {
    if (!this.info) return;
    if (!p || p.x < 0 || p.y < 0 || p.x > hostW || p.y > hostH) {
      this.el.style.visibility = 'hidden';
      return;
    }
    this.el.style.visibility = '';
    const flip = p.x + 18 + POP_W > hostW - 8;
    const left = flip ? p.x - 18 - POP_W : p.x + 18;
    const top = Math.min(Math.max(8, p.y - 24), Math.max(8, hostH - this.el.offsetHeight - 8));
    this.el.classList.toggle('flip', flip);
    this.el.style.left = `${Math.max(8, left)}px`;
    this.el.style.top = `${top}px`;
  }
}

function deviceInfo(id: DeviceId, ctx: FaceplateContext): DeviceInfo {
  const tag = (p: string) => () => {
    const unit = TAG_BY_PATH.get(p)?.unit;
    return formatTag(p, ctx.tag(p)) + (unit ? ` ${unit}` : '');
  };
  const sh = ctx.shadow;
  const v = ctx.vision;

  if ((SENSOR_IDS as readonly string[]).includes(id)) {
    const sid = id as SensorId;
    const k = SENSOR_IDS.indexOf(sid);
    const role = ['Infeed', 'Vision trigger', 'Reject trigger', 'Outfeed'][k];
    return {
      title: `${SENSOR_LABEL[sid]} · ${role} photo-eye`,
      asset: SENSOR_LABEL[sid],
      kind: 'Diffuse photoelectric · 24 V DC PNP · NO',
      rows: [
        ['Output', tag(`Sensors.${sid}`)],
        ['Beam position', () => `${SENSOR_X[sid].toFixed(2)} m`],
        ['Twin status', () => (sh.sensorSuspect[k] ? 'SUSPECT FAILED' : sh.blocked[k] ? 'BLOCKED (accumulation)' : 'OK')],
        ['Overdue in zone', () => (k > 0 ? String(sh.overdueInZone[k]) : '—')],
      ],
    };
  }
  switch (id) {
    case 'M001':
      return {
        title: 'M-001 · Drive gearmotor',
        asset: 'M-001',
        kind: '24 V DC PMDC · 60 W · i = 20 : 1',
        rows: [
          ['Duty', tag('Drive.Duty')],
          ['Shaft speed', tag('Drive.MotorSpeed')],
          ['Current (meas / model)', () => `${formatTag('Drive.MotorCurrent', ctx.tag('Drive.MotorCurrent'))} / ${sh.currentModel.toFixed(2)} A`],
          ['Winding temp', tag('Drive.MotorTemp')],
          ['Health index', () => `${sh.health.toFixed(0)} %`],
        ],
      };
    case 'ENC001':
      return {
        title: 'ENC-001 · Drive roller encoder',
        asset: 'ENC-001',
        kind: 'Incremental · 600 PPR · HTL · ×4 quadrature',
        rows: [
          ['Count', tag('Sensors.EncoderCount')],
          ['Speed', tag('Drive.SpeedActual')],
          ['Twin slip estimate', () => pct(Math.max(0, sh.slip))],
        ],
        note: 'Measures the drive roller, not the belt — slip is only visible to the twin through carton transit times.',
      };
    case 'CAM201':
      return {
        title: 'CAM-201 · Inspection camera',
        asset: 'CAM-201',
        kind: 'Area-scan · ring light · triggered by PE-201',
        rows: [
          ['Last request', tag('Inspection.RequestId')],
          ['Inspected', () => String(v.inspected)],
          ['Defects found', () => String(v.defects)],
          ['No-reads', () => String(v.noReads)],
          ['Avg. processing', () => (v.inspected ? `${(v.msSum / v.inspected).toFixed(2)} ms` : '—')],
        ],
      };
    case 'YV301':
      return {
        title: 'YV-301 · Reject pusher',
        asset: 'YV-301',
        kind: '5/2 solenoid valve · Ø16 pneumatic cylinder',
        rows: [
          ['Solenoid', tag('Actuators.YV301')],
          ['Rejected', tag('Counters.Rejected')],
          ['Valve cycles', () => String(ctx.maintenance.pusherCycles)],
          ['Tracking queue', tag('Tracking.QueueLength')],
        ],
      };
    case 'HL001':
      return {
        title: 'HL-001 · Stack light',
        asset: null,
        kind: 'Red / amber / green + horn · 24 V DC',
        rows: [
          ['Red', tag('Actuators.HL001_Red')],
          ['Amber', tag('Actuators.HL001_Amber')],
          ['Green', tag('Actuators.HL001_Green')],
          ['Horn', tag('Actuators.HL001_Buzzer')],
        ],
      };
    case 'ES001':
      return {
        title: 'ES-001 · Emergency stop',
        asset: null,
        kind: 'Twin-channel NC · Cat. 3 safety relay',
        rows: [
          ['Engaged', tag('Safety.ES001')],
          ['Abort reason', tag('Status.AbortReason')],
        ],
        note: 'The HMI cannot operate the E-stop (not a safety-rated channel). Use Plant sim to press it in the field.',
      };
    default:
      return {
        title: 'Belt · PVC conveyor belt',
        asset: 'BELT',
        kind: '1.20 m centres · 160 mm wide · Ø50 mm rollers',
        rows: [
          ['Encoder speed', tag('Drive.SpeedActual')],
          ['Twin belt speed', () => `${sh.beltSpeedEst.toFixed(3)} m/s`],
          ['Twin slip', () => pct(Math.max(0, sh.slip))],
          ['Speed limits', () => `${DRIVE.minSpeed}–${DRIVE.maxSpeed} m/s`],
        ],
      };
  }
}
