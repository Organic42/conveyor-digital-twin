/**
 * Time-travel recorder: keeps the last 10 minutes of plant frames together with the twin's
 * estimates at that moment, so any instant can be replayed in the 3D view and overview.
 */
import type { PlantFrame } from '../bus/protocol';
import type { GhostEstimate } from '../scene/scene';

export interface Snapshot {
  ts: number;
  frame: PlantFrame;
  ghosts: GhostEstimate[];
  jamZones: boolean[];
  sensorSuspect: boolean[];
}

export class Recorder {
  readonly snapshots: Snapshot[] = [];
  private last = 0;

  constructor(
    private readonly intervalMs = 100,
    private readonly capacity = 6000,
  ) {}

  record(f: PlantFrame, ghosts: GhostEstimate[], jamZones: boolean[], sensorSuspect: boolean[]): void {
    if (f.ts - this.last < this.intervalMs) return;
    this.last = f.ts;
    this.snapshots.push({
      ts: f.ts,
      frame: { ...f, events: [], vibration: undefined },
      ghosts: ghosts.map(({ id, x, overdue }) => ({ id, x, overdue })),
      jamZones: [...jamZones],
      sensorSuspect: [...sensorSuspect],
    });
    if (this.snapshots.length > this.capacity) this.snapshots.splice(0, this.snapshots.length - this.capacity);
  }

  get start(): number {
    return this.snapshots[0]?.ts ?? 0;
  }

  get end(): number {
    return this.snapshots[this.snapshots.length - 1]?.ts ?? 0;
  }

  /** Latest snapshot at or before `ts`. */
  at(ts: number): Snapshot | null {
    const s = this.snapshots;
    if (!s.length) return null;
    let lo = 0;
    let hi = s.length - 1;
    if (ts <= s[0].ts) return s[0];
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[mid].ts <= ts) lo = mid;
      else hi = mid - 1;
    }
    return s[lo];
  }
}
