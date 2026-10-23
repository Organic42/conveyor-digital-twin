/**
 * Maintenance (CMMS-style): the twin raises work orders from persistent asset conditions,
 * one open order per failure mode. Completing an order applies its repair to the virtual plant.
 */
import { SENSOR_IDS, SENSOR_LABEL } from '../plant/params';

export type WoStatus = 'OPEN' | 'IN PROGRESS' | 'DONE';
export type WoPriority = 'High' | 'Medium' | 'Low';

export interface WorkOrder {
  id: string;
  key: string; // failure mode — at most one open order per key
  asset: string;
  title: string;
  reason: string;
  priority: WoPriority;
  source: 'Twin' | 'Operator';
  status: WoStatus;
  created: number;
  started?: number;
  completed?: number;
  /** Plant-simulation faults reset when the order is completed (the "repair"). */
  repair: [string, unknown][];
}

export interface AssetCondition {
  health: number;
  currentResidual: number;
  rulS: number | null;
  slip: number;
  slipAlarm: boolean;
  sensorSuspect: boolean[];
  /** Camera label behind repeated no-reads, or null. */
  visionCamera: string | null;
  jamCount: number[];
  tripped: boolean;
  /** Learned-model anomaly that no rule explains: the asset its top contributor points at. */
  unexplained: { asset: string; signal: string; share: number } | null;
}

export class Maintenance {
  readonly orders: WorkOrder[] = [];
  version = 0;
  pusherCycles = 0;
  private nextNo = 1001;
  private since = new Map<string, number>();

  /** Raises orders for conditions that have persisted long enough; returns the new ones. */
  evaluate(c: AssetCondition, now: number): WorkOrder[] {
    const created: WorkOrder[] = [];
    const add = (o: WorkOrder | null) => o && created.push(o);

    // Predictive: plan the bearing job before the health limit is reached
    if (this.held('M001-RUL', c.rulS !== null && c.rulS > 0 && c.rulS < 150, now, 4000)) {
      add(
        this.raise({
          key: 'M001-BRG',
          asset: 'M-001',
          title: 'Planned bearing replacement (predictive)',
          reason: `VT-001 trend: RUL ≈ ${Math.round(c.rulS!)} s until vibration reaches ISO 10816 zone D (4.5 mm/s)`,
          priority: 'Medium',
          repair: [['bearingWear', 0], ['wearRate', 0]],
        }),
      );
    }
    if (this.held('M001-BRG', c.health < 70, now, 8000)) {
      add(
        this.raise({
          key: 'M001-BRG',
          asset: 'M-001',
          title: 'Inspect drive-train bearings and gearbox',
          reason: `Current +${c.currentResidual.toFixed(2)} A above model, health ${c.health.toFixed(0)} %`,
          priority: c.health < 45 ? 'High' : 'Medium',
          repair: [['bearingWear', 0], ['wearRate', 0]],
        }),
      );
    }
    if (this.held('ANOMALY', c.unexplained !== null, now, 6000)) {
      const u = c.unexplained!;
      add(
        this.raise({
          key: 'ANOMALY',
          asset: u.asset,
          title: `Investigate unexplained deviation at ${u.asset}`,
          reason: `Learned model only (no rule fired): ${u.signal} drives ${(u.share * 100).toFixed(0)} % of the deviation`,
          priority: 'Medium',
          repair: [['guideRub', false]],
        }),
      );
    }
    if (this.held('BELT-SLIP', c.slipAlarm, now, 8000)) {
      add(
        this.raise({
          key: 'BELT-SLIP',
          asset: 'BELT',
          title: 'Re-tension belt and clean drive-roller lagging',
          reason: `Twin estimates ${(c.slip * 100).toFixed(0)} % slip from carton transit times`,
          priority: 'Medium',
          repair: [['slip', 0]],
        }),
      );
    }
    SENSOR_IDS.forEach((id, k) => {
      if (this.held(`${id}-FAULT`, c.sensorSuspect[k], now, 3000)) {
        add(
          this.raise({
            key: `${id}-FAULT`,
            asset: SENSOR_LABEL[id],
            title: `Check alignment / replace photo-eye ${SENSOR_LABEL[id]}`,
            reason: 'Cartons detected downstream without an edge from this sensor',
            priority: 'Medium',
            repair: [['sensorFail', 'NONE']],
          }),
        );
      }
    });
    if (this.held('VISION', c.visionCamera !== null, now, 3000)) {
      add(
        this.raise({
          key: `VISION-${c.visionCamera}`,
          asset: c.visionCamera!,
          title: 'Clean lens, check ring light and camera cable',
          reason: 'Consecutive no-reads — cartons rejected fail-safe',
          priority: 'Medium',
          repair: [['cameraFail', 'NONE']],
        }),
      );
    }
    for (let z = 1; z <= 3; z++) {
      if (c.jamCount[z] >= 2) {
        add(
          this.raise({
            key: `ZONE${z}-JAM`,
            asset: `Zone ${z}`,
            title: `Inspect zone ${z} side guides — recurring jams`,
            reason: `${c.jamCount[z]} jams confirmed by the twin in this zone`,
            priority: 'Low',
            repair: [['jam', false]],
          }),
        );
      }
    }
    if (c.tripped) {
      add(
        this.raise({
          key: 'M001-TRIP',
          asset: 'M-001',
          title: 'Investigate motor over-temperature trip',
          reason: 'TT-001 reached 90 °C and the line aborted',
          priority: 'High',
          repair: [],
        }),
      );
    }
    return created;
  }

  raise(spec: Omit<WorkOrder, 'id' | 'status' | 'created' | 'source'> & { source?: WorkOrder['source'] }): WorkOrder | null {
    if (this.orders.some((o) => o.key === spec.key && o.status !== 'DONE')) return null;
    const o: WorkOrder = { source: 'Twin', ...spec, id: `WO-${this.nextNo++}`, status: 'OPEN', created: Date.now() };
    this.orders.unshift(o);
    this.version++;
    return o;
  }

  start(id: string): WorkOrder | null {
    const o = this.orders.find((x) => x.id === id);
    if (!o || o.status !== 'OPEN') return null;
    o.status = 'IN PROGRESS';
    o.started = Date.now();
    this.version++;
    return o;
  }

  complete(id: string): WorkOrder | null {
    const o = this.orders.find((x) => x.id === id);
    if (!o || o.status === 'DONE') return null;
    o.status = 'DONE';
    o.completed = Date.now();
    o.started ??= o.completed;
    this.since.delete(o.key);
    this.version++;
    return o;
  }

  openFor(asset: string): number {
    return this.orders.filter((o) => o.asset === asset && o.status !== 'DONE').length;
  }

  get openCount(): number {
    return this.orders.filter((o) => o.status === 'OPEN').length;
  }

  get inProgressCount(): number {
    return this.orders.filter((o) => o.status === 'IN PROGRESS').length;
  }

  get doneCount(): number {
    return this.orders.filter((o) => o.status === 'DONE').length;
  }

  /** Mean time to repair [s], creation → completion. */
  get mttr(): number | null {
    const done = this.orders.filter((o) => o.completed);
    if (!done.length) return null;
    return done.reduce((s, o) => s + (o.completed! - o.created), 0) / done.length / 1000;
  }

  private held(key: string, cond: boolean, now: number, ms: number): boolean {
    if (!cond) {
      this.since.delete(key);
      return false;
    }
    if (!this.since.has(key)) this.since.set(key, now);
    return now - this.since.get(key)! >= ms;
  }
}
