/**
 * OEE = Availability × Performance × Quality, per shift.
 *  Planned time  — all time after the first start, except operator stops (STOPPED / IDLE)
 *  Availability  — EXECUTE time / planned time
 *  Performance   — (total count × ideal cycle time) / EXECUTE time
 *  Quality       — good count / total count
 */
import { IDEAL_CYCLE } from '../plant/params';
import { PackML, STATE_NAME } from '../plant/model';
import type { TagValue } from '../plant/model';

const NOT_PLANNED = new Set<number>([PackML.Stopped, PackML.Idle]);

export interface OeeSnapshot {
  availability: number;
  performance: number;
  quality: number;
  oee: number;
  planned: number;
  run: number;
  good: number;
  rejected: number;
  ratePerMin: number;
  stateTimes: [string, number][];
}

export class OeeTracker {
  shiftStart = Date.now();
  shiftNo = 1;
  private started = false;
  private stateTime = new Map<number, number>();
  private base = { good: 0, rejected: 0 };
  private last = { good: 0, rejected: 0 };
  private history: [number, number][] = []; // [ts, total]
  private lastTs = 0;

  update(tags: Record<string, TagValue>, ts: number): void {
    const state = Number(tags['Status.State']);
    const dt = this.lastTs ? Math.min(0.5, (ts - this.lastTs) / 1000) : 0;
    this.lastTs = ts;
    if (state === PackML.Execute) this.started = true;
    if (this.started) this.stateTime.set(state, (this.stateTime.get(state) ?? 0) + dt);

    this.last = { good: Number(tags['Counters.Outfeed']), rejected: Number(tags['Counters.Rejected']) };
    this.history.push([ts, this.last.good + this.last.rejected]);
    while (this.history.length && ts - this.history[0][0] > 60_000) this.history.shift();
  }

  newShift(): void {
    this.shiftNo++;
    this.shiftStart = Date.now();
    this.started = false;
    this.stateTime.clear();
    this.base = { ...this.last };
  }

  snapshot(): OeeSnapshot {
    let planned = 0;
    for (const [s, t] of this.stateTime) if (!NOT_PLANNED.has(s)) planned += t;
    const run = this.stateTime.get(PackML.Execute) ?? 0;
    const good = this.last.good - this.base.good;
    const rejected = this.last.rejected - this.base.rejected;
    const total = good + rejected;
    const availability = planned > 0 ? run / planned : 0;
    const performance = run > 0 ? Math.min(1, (total * IDEAL_CYCLE) / run) : 0;
    const quality = total > 0 ? good / total : 0;

    let ratePerMin = 0;
    if (this.history.length > 1) {
      const [t0, c0] = this.history[0];
      const [t1, c1] = this.history[this.history.length - 1];
      if (t1 - t0 > 5000) ratePerMin = ((c1 - c0) / (t1 - t0)) * 60_000;
    }

    const stateTimes = [...this.stateTime.entries()]
      .filter(([, t]) => t > 0.05)
      .sort((a, b) => b[1] - a[1])
      .map(([s, t]) => [STATE_NAME[s], t] as [string, number]);

    return {
      availability,
      performance,
      quality,
      oee: availability * performance * quality,
      planned,
      run,
      good,
      rejected,
      ratePerMin,
      stateTimes,
    };
  }
}
