/**
 * Alarm manager following the ISA-18.2 alarm state model:
 *   NORMAL → UNACK (active, unacknowledged) → ACKED (active, acknowledged) → NORMAL
 *   UNACK  → RTN_UNACK (returned to normal, unacknowledged) → NORMAL on acknowledge
 */

export type Priority = 1 | 2 | 3;
export type AlarmState = 'UNACK' | 'ACKED' | 'RTN_UNACK';

export interface AlarmDef {
  id: string;
  tag: string;
  text: string;
  priority: Priority;
}

export interface Alarm extends AlarmDef {
  state: AlarmState;
  activeSince: number;
  lastChange: number;
  detail: string;
}

export type JournalKind = 'ALARM' | 'RTN' | 'ACK' | 'CMD' | 'STATE' | 'EVENT' | 'TWIN' | 'MAINT';

export interface JournalEntry {
  ts: number;
  kind: JournalKind;
  source: string;
  text: string;
  priority?: Priority; // set on ALARM entries (used for replay timeline markers)
}

export class AlarmManager {
  readonly alarms = new Map<string, Alarm>();
  readonly journal: JournalEntry[] = [];
  version = 0; // bumped on every change, lets the UI skip redundant renders

  set(def: AlarmDef, active: boolean, detail = ''): void {
    const now = Date.now();
    const a = this.alarms.get(def.id);
    if (active) {
      if (!a) {
        this.alarms.set(def.id, { ...def, state: 'UNACK', activeSince: now, lastChange: now, detail });
        this.log('ALARM', def.id, `${def.text}${detail ? ` (${detail})` : ''}`, def.priority);
      } else {
        if (a.state === 'RTN_UNACK') {
          a.state = 'UNACK';
          a.activeSince = now;
          a.lastChange = now;
          this.log('ALARM', def.id, def.text, def.priority);
        }
        if (a.detail !== detail) {
          a.detail = detail;
          this.version++;
        }
      }
    } else if (a && a.state !== 'RTN_UNACK') {
      this.log('RTN', def.id, `${def.text} — returned to normal`);
      if (a.state === 'ACKED') this.alarms.delete(def.id);
      else {
        a.state = 'RTN_UNACK';
        a.lastChange = now;
      }
    }
  }

  isActive(id: string): boolean {
    const a = this.alarms.get(id);
    return !!a && a.state !== 'RTN_UNACK';
  }

  ack(id: string): void {
    const a = this.alarms.get(id);
    if (!a || a.state === 'ACKED') return;
    this.log('ACK', id, `Acknowledged: ${a.text}`);
    if (a.state === 'RTN_UNACK') this.alarms.delete(id);
    else {
      a.state = 'ACKED';
      a.lastChange = Date.now();
    }
  }

  ackAll(): void {
    for (const id of [...this.alarms.keys()]) this.ack(id);
  }

  sorted(): Alarm[] {
    return [...this.alarms.values()].sort((a, b) => a.priority - b.priority || b.activeSince - a.activeSince);
  }

  counts(): Record<Priority, number> {
    const c: Record<Priority, number> = { 1: 0, 2: 0, 3: 0 };
    for (const a of this.alarms.values()) if (a.state !== 'RTN_UNACK') c[a.priority]++;
    return c;
  }

  /** Highest-priority alarm still waiting for acknowledgement (drives the alarm banner). */
  topUnacked(): Alarm | null {
    return this.sorted().find((a) => a.state !== 'ACKED') ?? null;
  }

  log(kind: JournalKind, source: string, text: string, priority?: Priority): void {
    this.journal.unshift({ ts: Date.now(), kind, source, text, priority });
    if (this.journal.length > 500) this.journal.pop();
    this.version++;
  }
}
