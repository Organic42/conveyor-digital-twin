/**
 * Twin-side client of the plant link: subscription to the cyclic process image and
 * method calls with status codes. This is the only seam between twin and plant — swap the
 * worker for an OPC UA / MQTT gateway and nothing above this file changes.
 */
import PlantWorker from '../plant/plant.worker?worker&inline';
import type { CallResult, TagValue } from '../plant/model';
import type { CallRequest, PlantFrame, PlantMessage } from './protocol';

export class PlantLink {
  private readonly worker: Worker = new PlantWorker();
  private readonly pending = new Map<number, (r: CallResult) => void>();
  private readonly listeners: ((f: PlantFrame) => void)[] = [];
  private nextId = 1;
  private arrivals: number[] = [];

  frame: PlantFrame | null = null;
  receivedAt = 0; // performance.now() at arrival of the latest frame
  latencyMs = 0;
  rateHz = 0;

  constructor() {
    this.worker.onmessage = (e: MessageEvent<PlantMessage>) => {
      const msg = e.data;
      if (msg.type === 'reply') {
        this.pending.get(msg.id)?.(msg.result);
        this.pending.delete(msg.id);
        return;
      }
      const now = performance.now();
      this.frame = msg;
      this.receivedAt = now;
      this.latencyMs += (Math.max(0, Date.now() - msg.ts) - this.latencyMs) * 0.1;
      this.arrivals.push(now);
      while (this.arrivals.length && now - this.arrivals[0] > 1000) this.arrivals.shift();
      this.rateHz = this.arrivals.length;
      for (const fn of this.listeners) fn(msg);
    };
  }

  get connected(): boolean {
    return this.frame !== null && performance.now() - this.receivedAt < 1000;
  }

  onFrame(fn: (f: PlantFrame) => void): void {
    this.listeners.push(fn);
  }

  tag(path: string): TagValue | undefined {
    return this.frame?.tags[path];
  }

  call(method: string, ...args: unknown[]): Promise<CallResult> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      const req: CallRequest = { type: 'call', id, method, args };
      this.worker.postMessage(req);
    });
  }
}
