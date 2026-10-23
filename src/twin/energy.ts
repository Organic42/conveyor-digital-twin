/**
 * Energy meter for the line: drive power from the PWM duty and armature current, plus the
 * constant 24 V control circuit (PLC, photo-eyes, encoder, camera + ring light, valve).
 */
import { MOTOR } from '../plant/params';
import { PackML, type TagValue } from '../plant/model';

export const CONTROL_POWER_W = 9;
/** Grid emission factor, India (CEA baseline database, approx.). */
export const GRID_KG_CO2_PER_KWH = 0.71;

export function drivePower(dutyPct: number, current: number): number {
  return MOTOR.supplyVoltage * (dutyPct / 100) * Math.max(0, current);
}

export class EnergyMeter {
  drivePowerW = 0;
  powerW = CONTROL_POWER_W;
  driveWh = 0;
  controlWh = 0;
  idleWh = 0;
  private good = 0;
  private baseGood = 0;
  private lastTs = 0;

  update(tags: Record<string, TagValue>, ts: number): void {
    const dt = this.lastTs ? Math.min(0.5, (ts - this.lastTs) / 1000) : 0;
    this.lastTs = ts;
    this.drivePowerW = drivePower(Number(tags['Drive.Duty']), Number(tags['Drive.MotorCurrent']));
    this.powerW = this.drivePowerW + CONTROL_POWER_W;
    this.driveWh += (this.drivePowerW * dt) / 3600;
    this.controlWh += (CONTROL_POWER_W * dt) / 3600;
    if (tags['Status.State'] !== PackML.Execute) this.idleWh += (this.powerW * dt) / 3600;
    this.good = Number(tags['Counters.Outfeed']) - this.baseGood;
  }

  newShift(tags: Record<string, TagValue>): void {
    this.driveWh = this.controlWh = this.idleWh = 0;
    this.baseGood = Number(tags['Counters.Outfeed'] ?? 0);
    this.good = 0;
  }

  get totalWh(): number {
    return this.driveWh + this.controlWh;
  }

  /** Joules per good carton this shift. */
  get perCartonJ(): number | null {
    return this.good > 0 ? (this.totalWh * 3600) / this.good : null;
  }

  get idleShare(): number {
    return this.totalWh > 0 ? this.idleWh / this.totalWh : 0;
  }

  /** g CO₂e per 1000 good cartons. */
  get co2PerThousand(): number | null {
    const j = this.perCartonJ;
    return j === null ? null : (j / 3.6e6) * GRID_KG_CO2_PER_KWH * 1000 * 1000;
  }
}
