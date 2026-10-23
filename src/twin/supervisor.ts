/**
 * Supervisor — turns plant tags and shadow-model residuals into alarms, and closes the loop
 * back to the plant (auto-protect hold on a confirmed jam).
 */
import { SENSOR_IDS, SENSOR_LABEL, THERMAL } from '../plant/params';
import { PackML } from '../plant/model';
import type { PlantFrame } from '../bus/protocol';
import type { CallResult } from '../plant/model';
import type { AlarmDef, AlarmManager } from './alarms';
import type { ShadowModel } from './shadow';

const ZONE_NAME = ['', 'zone 1 (PE-101 → PE-201)', 'zone 2 (PE-201 → PE-301)', 'zone 3 (PE-301 → PE-401)'];

export const ALARMS = {
  comm: { id: 'LINK.COMM', tag: 'Plant link', text: 'Communication lost with plant controller', priority: 1 },
  estop: { id: 'ES001.ACTIVE', tag: 'Safety.ES001', text: 'Emergency stop ES-001 engaged', priority: 1 },
  trip: { id: 'M001.TRIP', tag: 'Drive.MotorTemp', text: 'Motor over-temperature trip — line aborted', priority: 1 },
  tempHi: { id: 'TT001.HI', tag: 'Drive.MotorTemp', text: 'Motor winding temperature high', priority: 2 },
  slip: { id: 'BELT.SLIP', tag: 'Twin.Slip', text: 'Belt slip — transit time disagrees with encoder', priority: 2 },
  load: { id: 'M001.LOAD', tag: 'Twin.CurrentResidual', text: 'Drive-train load above model — friction / bearing wear', priority: 2 },
  forecast: { id: 'M001.FORECAST', tag: 'Twin.Thermal', text: 'Over-temperature trip forecast', priority: 3 },
  vision: { id: 'VISION.NOREAD', tag: 'Vision tunnel', text: 'Vision no-read — cartons rejected fail-safe', priority: 3 },
} satisfies Record<string, AlarmDef>;

/** What the supervisor needs from the plant link (the live link, or a headless plant in the benchmark). */
export interface PlantCommands {
  call(method: string, ...args: unknown[]): Promise<CallResult>;
  readonly connected: boolean;
  readonly frame: unknown;
}

const jamAlarm = (zone: number): AlarmDef => ({
  id: `JAM.Z${zone}`,
  tag: `Twin.Zone${zone}`,
  text: `Jam confirmed in ${ZONE_NAME[zone]}`,
  priority: 1,
});

const sensorAlarm = (k: number): AlarmDef => ({
  id: `${SENSOR_IDS[k]}.FAULT`,
  tag: `Sensors.${SENSOR_IDS[k]}`,
  text: `${SENSOR_LABEL[SENSOR_IDS[k]]} not responding — cartons detected downstream`,
  priority: 2,
});

export class Supervisor {
  autoProtect = true;
  visionNoReads = 0;
  visionNoReadCamera = '';
  private slipLatched = false;
  private loadSince: number | null = null;
  private loadLatched = false;
  private tempLatched = false;
  /** Confirmed jam per belt zone (index = zone 1..3). */
  readonly jamZones = [false, false, false, false];
  /** Jams confirmed per zone since the last zone inspection work order was completed. */
  readonly jamCount = [0, 0, 0, 0];

  constructor(
    private readonly link: PlantCommands,
    private readonly alarms: AlarmManager,
    private readonly shadow: ShadowModel,
  ) {}

  evaluate(f: PlantFrame): void {
    const tags = f.tags;
    const state = Number(tags['Status.State']);
    const running = state === PackML.Execute;
    const temp = Number(tags['Drive.MotorTemp']);
    const sh = this.shadow;

    for (const ev of f.events) this.alarms.log(ev.text.startsWith('State') ? 'STATE' : 'EVENT', 'PLC', ev.text);

    this.alarms.set(ALARMS.estop, Boolean(tags['Safety.ES001']));
    this.alarms.set(
      ALARMS.trip,
      tags['Status.AbortReason'] === 'OVERTEMP' && (state === PackML.Aborted || state === PackML.Aborting),
    );

    // Temperature high with deadband
    if (temp >= THERMAL.highAlarm) this.tempLatched = true;
    else if (temp < THERMAL.highAlarmReset) this.tempLatched = false;
    this.alarms.set(ALARMS.tempHi, this.tempLatched, `${temp.toFixed(1)} °C`);

    // Belt slip with deadband
    if (sh.slip > 0.08) this.slipLatched = true;
    else if (sh.slip < 0.04) this.slipLatched = false;
    this.alarms.set(ALARMS.slip, this.slipLatched, `${(sh.slip * 100).toFixed(0)} %`);

    // Current residual sustained for 3 s
    const now = f.ts;
    if (sh.currentResidual > 0.3) {
      this.loadSince ??= now;
      if (now - this.loadSince > 3000) this.loadLatched = true;
    } else {
      this.loadSince = null;
      if (sh.currentResidual < 0.15) this.loadLatched = false;
    }
    this.alarms.set(ALARMS.load, this.loadLatched, `+${sh.currentResidual.toFixed(2)} A`);

    const trip = sh.thermal.toTrip;
    this.alarms.set(ALARMS.forecast, running && trip !== null && trip < 600, trip !== null ? `in ${fmtDuration(trip)}` : '');

    // Jam vs sensor fault diagnosis
    for (let zone = 1; zone <= 3; zone++) {
      const jam = (sh.overdueInZone[zone] >= 2 && !sh.sensorSuspect[zone]) || sh.blocked[zone - 1];
      this.alarms.set(jamAlarm(zone), jam);
      if (jam && !this.jamZones[zone]) {
        this.jamCount[zone]++;
        if (this.autoProtect && running) {
          this.alarms.log('TWIN', 'Auto-protect', `Jam in zone ${zone} confirmed → Hold issued to plant`);
          void this.link.call('Hold');
        }
      }
      this.jamZones[zone] = jam;
    }
    for (let k = 1; k < 4; k++) this.alarms.set(sensorAlarm(k), sh.sensorSuspect[k]);

    this.alarms.set(ALARMS.vision, this.visionNoReads >= 2, this.visionNoReadCamera);
  }

  checkLink(): void {
    this.alarms.set(ALARMS.comm, !this.link.connected && this.link.frame !== null);
  }
}

export function fmtDuration(s: number): string {
  if (!Number.isFinite(s)) return '—';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m > 0 ? `${m} min ${sec.toString().padStart(2, '0')} s` : `${sec} s`;
}
