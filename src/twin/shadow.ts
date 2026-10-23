/**
 * Shadow model — the twin's own estimate of the machine, built only from plant tags.
 *
 *  • Carton tracking: predicts each carton's position from encoder travel and corrects it on every
 *    photo-eye edge (predict / correct, like a PLC shift register but independent of the PLC).
 *  • Residuals: transit-time vs encoder (belt slip), measured vs modelled current (friction / wear),
 *    missing or skipped sensor events (jam vs sensor failure).
 *  • Thermal forecast from the first-order winding model.
 */
import { BELT, GEOMETRY as G, MOTOR as M, SENSOR_IDS, SENSOR_X, THERMAL, DRIVE } from '../plant/params';
import { METERS_PER_COUNT, PackML } from '../plant/model';
import type { PlantFrame } from '../bus/protocol';

const SX = SENSOR_IDS.map((id) => SENSOR_X[id]);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface Track {
  id: number;
  k: number; // index of the last photo-eye that saw this carton
  encAtK: number; // encoder travel [m] at that event
  overdue: boolean; // expected at the next photo-eye but not seen
  clean: boolean; // belt ran continuously since the last event (usable for slip estimation)
  x: number; // estimated centre position [m]
}

export interface ThermalForecast {
  steadyState: number;
  toHighAlarm: number | null; // seconds
  toTrip: number | null;
}

/** Steady-state current the twin's motor model expects at belt speed v with n cartons. */
export function modelCurrent(v: number, n: number, accel = 0): number {
  const omega = (v / G.rollerRadius) * M.gearRatio;
  if (omega < 1) return 0;
  const drag = BELT.baseDrag + n * BELT.muCarry * G.itemMass * 9.81;
  const tLoad = (drag * G.rollerRadius) / (M.gearRatio * M.gearEfficiency);
  const alpha = (accel / G.rollerRadius) * M.gearRatio;
  return (M.b * omega + M.Tc + tLoad + M.J * alpha) / M.Kt;
}

export class ShadowModel {
  tracks: Track[] = [];
  slip = 0;
  beltSpeedEst = 0;
  currentModel = 0;
  currentResidual = 0;
  health = 100;
  thermal: ThermalForecast = { steadyState: THERMAL.ambient, toHighAlarm: null, toTrip: null };

  /** Measured encoder travel per metre of zone length for cartons crossing zone k (1 = nominal). */
  zoneRatio = [1, 1, 1, 1];
  sensorSuspect = [false, false, false, false];
  blocked = [false, false, false, false]; // accumulation in front of a photo-eye
  overdueInZone = [0, 0, 0, 0]; // zone k lies between PE[k-1] and PE[k]
  readonly notes: string[] = [];

  private nextId = 1;
  private pePrev = [false, false, false, false];
  private pusherPrev = false;
  private blockedFrom: (number | null)[] = [null, null, null, null];
  private lastT = 0;
  private vPrev = 0;
  private accel = 0;
  private i2 = 0;

  update(f: PlantFrame): void {
    const tags = f.tags;
    const t = f.ts / 1000;
    const dt = this.lastT ? clamp(t - this.lastT, 0, 0.5) : 0;
    this.lastT = t;

    const d = Number(tags['Sensors.EncoderCount']) * METERS_PER_COUNT;
    const running = tags['Status.State'] === PackML.Execute;
    const pe = SENSOR_IDS.map((id) => Boolean(tags[`Sensors.${id}`]));
    const pusher = Boolean(tags['Actuators.YV301']);

    // Transit times are only valid slip evidence while cartons flow freely
    const disturbed = this.blocked.some(Boolean) || this.overdueInZone.some((n) => n > 0);
    if (!running || disturbed) for (const tr of this.tracks) tr.clean = false;

    for (let k = 0; k < 4; k++) if (pe[k] && !this.pePrev[k]) this.onArrival(k, d);
    if (!pe[3] && this.pePrev[3]) this.removeFirst((tr) => tr.k === 3);
    if (pusher && !this.pusherPrev) this.onReject();

    // Predict positions; flag cartons that did not reach the next photo-eye in time
    for (const tr of this.tracks) {
      const travelled = d - tr.encAtK;
      if (tr.k < 3) {
        const expected = (SX[tr.k + 1] - SX[tr.k]) / (1 - this.slip);
        if (!tr.overdue && travelled > expected * 1.3 + 0.03) tr.overdue = true;
        if (travelled > expected * 6 + 0.5) {
          tr.k = -1; // lost: belt ran far beyond any plausible transit, drop the estimate
          this.note(`Track #${tr.id} lost after ${travelled.toFixed(2)} m of belt travel`);
        }
      }
      let lead = SX[tr.k] + travelled * (1 - this.slip);
      if (tr.k < 3) lead = Math.min(lead, SX[tr.k + 1] - 0.004);
      tr.x = Math.min(lead - G.itemLength / 2, G.length);
    }
    this.tracks = this.tracks.filter((tr) => tr.k >= 0);
    if (this.tracks.length > 16) this.tracks.splice(0, this.tracks.length - 16);
    this.overdueInZone = [0, 1, 2, 3].map((k) => this.tracks.filter((tr) => tr.overdue && tr.k === k - 1).length);

    // Accumulation: a photo-eye stays blocked while the belt moves several carton lengths
    for (let k = 0; k < 4; k++) {
      if (pe[k]) {
        if (this.blockedFrom[k] === null) this.blockedFrom[k] = d;
        this.blocked[k] = d - (this.blockedFrom[k] ?? d) > 3 * G.itemLength;
      } else {
        this.blockedFrom[k] = null;
        this.blocked[k] = false;
      }
    }

    // Drive model
    const v = Number(tags['Drive.SpeedActual']);
    if (dt > 0) this.accel += ((v - this.vPrev) / dt - this.accel) * Math.min(1, dt / 0.3);
    this.vPrev = v;
    this.beltSpeedEst = v * (1 - this.slip);
    this.currentModel = modelCurrent(v, this.tracks.length, this.accel);
    const iMeas = Number(tags['Drive.MotorCurrent']);
    if (running && v > 0.05 && Math.abs(this.accel) < 0.05 && dt > 0) {
      this.currentResidual += (iMeas - this.currentModel - this.currentResidual) * Math.min(1, dt / 2);
    }
    // 0 % ≙ +1.5 A above model: rated current would be exceeded at nominal speed
    this.health = clamp(100 - (Math.max(0, this.currentResidual) / 1.5) * 100, 0, 100);

    // Thermal forecast: T(t) = Tss + (T0 − Tss)·e^(−t/τ)
    if (dt > 0) this.i2 += (iMeas * iMeas - this.i2) * Math.min(1, dt / 15);
    const T = Number(tags['Drive.MotorTemp']);
    const tss = THERMAL.ambient + this.i2 * M.R * THERMAL.Rth;
    const tau = THERMAL.Rth * THERMAL.Cth;
    const timeTo = (limit: number) =>
      tss > limit && T < limit ? -tau * Math.log((tss - limit) / (tss - T)) : null;
    this.thermal = { steadyState: tss, toHighAlarm: timeTo(THERMAL.highAlarm), toTrip: timeTo(THERMAL.trip) };

    this.pePrev = pe;
    this.pusherPrev = pusher;
  }

  /** Highest belt speed whose steady-state winding temperature stays below `limit`. */
  maxSustainableSpeed(limit: number = THERMAL.highAlarm - 3): number | null {
    for (let v = DRIVE.maxSpeed; v >= DRIVE.minSpeed - 1e-9; v -= 0.01) {
      const i = modelCurrent(v, 4) + Math.max(0, this.currentResidual);
      if (THERMAL.ambient + i * i * M.R * THERMAL.Rth < limit) return Math.round(v * 100) / 100;
    }
    return null;
  }

  private onArrival(k: number, d: number): void {
    if (k === 0) {
      this.tracks.push({ id: this.nextId++, k: 0, encAtK: d, overdue: false, clean: true, x: SX[0] });
      return;
    }
    let tr = this.tracks.find((t) => t.k === k - 1);
    if (tr) {
      if (tr.clean) {
        const dEnc = d - tr.encAtK;
        const inst = dEnc > 0.05 ? 1 - (SX[k] - SX[k - 1]) / dEnc : NaN;
        if (inst > -0.1 && inst < 0.45) {
          this.slip += (inst - this.slip) * 0.35; // reject outliers
          this.zoneRatio[k] += (dEnc / (SX[k] - SX[k - 1]) - this.zoneRatio[k]) * 0.3;
        }

      }
    } else if (k >= 2) {
      // An overdue carton appeared without being seen by the previous photo-eye → that sensor is suspect
      tr = this.tracks.find((t) => t.k === k - 2 && t.overdue);
      if (tr && !this.sensorSuspect[k - 1]) {
        this.sensorSuspect[k - 1] = true;
        this.note(`Carton #${tr.id} skipped ${SENSOR_IDS[k - 1]} and was seen at ${SENSOR_IDS[k]}`);
      }
    }
    this.sensorSuspect[k] = false;
    if (!tr) {
      // Carton the twin had lost (e.g. after a long jam) — re-acquire it, keeping downstream-first order
      const fresh: Track = { id: this.nextId++, k, encAtK: d, overdue: false, clean: false, x: SX[k] };
      const at = this.tracks.findIndex((t) => t.k < k);
      this.tracks.splice(at < 0 ? this.tracks.length : at, 0, fresh);
      this.note(`Untracked carton re-acquired at ${SENSOR_IDS[k]} as #${fresh.id}`);
      return;
    }
    tr.k = k;
    tr.encAtK = d;
    tr.overdue = false;
    tr.clean = true;
  }

  private onReject(): void {
    let best = -1;
    let bestDx = Infinity;
    this.tracks.forEach((tr, i) => {
      const dx = Math.abs(tr.x - G.pusherX);
      if (tr.k === 2 && dx < bestDx) {
        best = i;
        bestDx = dx;
      }
    });
    if (best >= 0) this.tracks.splice(best, 1);
  }

  private removeFirst(pred: (t: Track) => boolean): void {
    const i = this.tracks.findIndex(pred);
    if (i >= 0) this.tracks.splice(i, 1);
  }

  private note(text: string): void {
    this.notes.unshift(text);
    if (this.notes.length > 6) this.notes.pop();
  }
}
