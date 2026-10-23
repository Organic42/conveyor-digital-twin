/**
 * Virtual plant — the stand-in for the physical conveyor and its controller.
 *
 * Each call to step() is one PLC scan: read inputs → run control program → write outputs,
 * followed by the physics integration of the machine for the scan interval.
 * Nothing in the twin reads this class directly; it only sees readTags() over the plant link.
 */
import {
  BELT,
  DRIVE,
  ENCODER,
  GEOMETRY as G,
  INSPECTION,
  MOTOR as M,
  PUSHER,
  SENSOR_IDS,
  SENSOR_X,
  THERMAL,
  type SensorId,
} from './params';

/** PackML machine states (ISA-TR88.00.02 state numbers). */
export enum PackML {
  Clearing = 1,
  Stopped = 2,
  Starting = 3,
  Idle = 4,
  Execute = 6,
  Stopping = 7,
  Aborting = 8,
  Aborted = 9,
  Holding = 10,
  Held = 11,
  Unholding = 12,
  Resetting = 15,
}

export const STATE_NAME: Record<number, string> = {
  [PackML.Clearing]: 'CLEARING',
  [PackML.Stopped]: 'STOPPED',
  [PackML.Starting]: 'STARTING',
  [PackML.Idle]: 'IDLE',
  [PackML.Execute]: 'EXECUTE',
  [PackML.Stopping]: 'STOPPING',
  [PackML.Aborting]: 'ABORTING',
  [PackML.Aborted]: 'ABORTED',
  [PackML.Holding]: 'HOLDING',
  [PackML.Held]: 'HELD',
  [PackML.Unholding]: 'UNHOLDING',
  [PackML.Resetting]: 'RESETTING',
};

const ALL_ACTIVE = [
  PackML.Clearing,
  PackML.Stopped,
  PackML.Starting,
  PackML.Idle,
  PackML.Execute,
  PackML.Stopping,
  PackML.Holding,
  PackML.Held,
  PackML.Unholding,
  PackML.Resetting,
];

/** Operator commands and the states they are accepted in. */
export const TRANSITIONS: Record<string, { from: PackML[]; to: PackML }> = {
  Reset: { from: [PackML.Stopped], to: PackML.Resetting },
  Start: { from: [PackML.Idle], to: PackML.Starting },
  Stop: {
    from: [PackML.Idle, PackML.Starting, PackML.Execute, PackML.Holding, PackML.Held, PackML.Unholding, PackML.Resetting],
    to: PackML.Stopping,
  },
  Hold: { from: [PackML.Execute], to: PackML.Holding },
  Unhold: { from: [PackML.Held], to: PackML.Unholding },
  Abort: { from: ALL_ACTIVE, to: PackML.Aborting },
  Clear: { from: [PackML.Aborted], to: PackML.Clearing },
};

export type TagValue = number | boolean | string;
export type Verdict = 'GOOD' | 'DEFECT' | 'NO_READ';
export type ItemPhase = 'conveying' | 'stopped' | 'rejecting' | 'falling';
export type AbortReason = 'NONE' | 'ESTOP' | 'OVERTEMP' | 'OPERATOR';
export type StatusCode =
  | 'Good'
  | 'BadInvalidState'
  | 'BadConditionNotMet'
  | 'BadOutOfRange'
  | 'BadNodeIdUnknown'
  | 'BadMethodInvalid';

export interface CallResult {
  status: StatusCode;
  message?: string;
}

export interface Item {
  id: number;
  x: number; // centre position along the belt [m]
  y: number; // vertical offset from resting on the belt [m]
  z: number; // lateral offset from belt centreline [m]
  vy: number;
  defect: boolean;
  phase: ItemPhase;
  dest: 'reject' | 'outfeed' | null;
}

export interface FaultState {
  slip: number; // belt slip on the drive roller, 0..0.35
  jam: boolean; // obstruction in zone 2
  sensorFail: SensorId | 'NONE'; // photo-eye output stuck off
  bearingWear: number; // 0..1, raises Coulomb friction
  cameraFail: boolean; // CAM-201 delivers no image
  defectRate: number; // share of defective cartons from upstream
}

export interface PlantEvent {
  t: number;
  text: string;
}

interface TrackEntry {
  tid: number;
  verdict: Verdict | 'PENDING';
  enc: number; // encoder count when the carton passed PE-201
}

const COUNTS_PER_REV = ENCODER.ppr * ENCODER.quadrature;
export const METERS_PER_COUNT = (2 * Math.PI * G.rollerRadius) / COUNTS_PER_REV;
const V_NO_LOAD = (M.supplyVoltage / M.Ke / M.gearRatio) * G.rollerRadius;
const SUBSTEPS = 4;
const GRAVITY = 9.81;
/** Gap between accumulated cartons (flaps / rounded edges keep the photo-eye gaps resolvable). */
const ACCUMULATION_GAP = 0.02;
/** Encoder travel from the PE-301 rising edge until the carton centre is in front of the pusher. */
const PUSH_DELAY_COUNTS = (G.pusherX - (SENSOR_X.PE301 - G.itemLength / 2) - 0.02) / METERS_PER_COUNT;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PlantOptions {
  seed?: number;
  /** When > 0 the plant inspects cartons itself with this accuracy (headless what-if runs). */
  autoInspectAccuracy?: number;
}

export class Plant {
  t = 0;
  state: PackML = PackML.Stopped;
  stateTime = 0;
  abortReason: AbortReason = 'NONE';

  speedSetpoint: number = DRIVE.defaultSpeed;
  rampSetpoint = 0;
  duty = 0;
  private integral = 0;

  current = 0;
  private omega = 0; // motor shaft [rad/s]
  rollerAngle = 0;
  private encoderAcc = 0;
  private encHistory: number[] = [];
  speedActual = 0; // belt speed derived from ENC-001
  temperature: number = THERMAL.initial;

  beltDistance = 0;
  beltSpeed = 0; // true belt surface speed (differs from encoder under slip)
  private slipActual = 0;
  private wearActual = 0;

  items: Item[] = [];
  private nextItemId = 1;
  private nextSpawnAt = 0.05;

  private raw = [false, false, false, false];
  pe = [false, false, false, false];
  private peLast = [false, false, false, false];

  counters = { infeed: 0, inspected: 0, rejected: 0, outfeed: 0 };
  truth = { escapedDefects: 0, falseRejects: 0, defectsProduced: 0 };

  private tracking: TrackEntry[] = [];
  private nextTid = 1;
  inspectionRequest = 0;

  private pusherQueue: number[] = [];
  pusherPhase: 'idle' | 'extending' | 'dwell' | 'retracting' = 'idle';
  pusherZ: number = PUSHER.retractedZ;
  private pusherTimer = 0;

  estop = false;
  faults: FaultState = { slip: 0, jam: false, sensorFail: 'NONE', bearingWear: 0, cameraFail: false, defectRate: 0.12 };
  lights = { red: false, amber: true, green: false, buzzer: false };
  events: PlantEvent[] = [];

  private readonly rand: () => number;
  private readonly autoInspect: number;

  constructor(opts: PlantOptions = {}) {
    this.rand = mulberry32(opts.seed ?? 1);
    this.autoInspect = opts.autoInspectAccuracy ?? 0;
  }

  get encoderCount(): number {
    return Math.floor(this.encoderAcc);
  }

  /** Initial condition for headless what-if runs. */
  setCondition(c: { temperature?: number; wear?: number; slip?: number }): void {
    if (c.temperature !== undefined) this.temperature = c.temperature;
    if (c.wear !== undefined) this.wearActual = this.faults.bearingWear = c.wear;
    if (c.slip !== undefined) this.slipActual = this.faults.slip = c.slip;
  }

  // ───────────────────────────── methods (OPC UA-style) ─────────────────────────────

  call(method: string, args: unknown[] = []): CallResult {
    const tr = TRANSITIONS[method];
    if (tr) {
      if (!tr.from.includes(this.state)) {
        return { status: 'BadInvalidState', message: `${method} not allowed in ${STATE_NAME[this.state]}` };
      }
      if ((method === 'Clear' || method === 'Reset') && this.estop) {
        return { status: 'BadConditionNotMet', message: 'E-stop ES-001 still engaged' };
      }
      if (method === 'Start' && this.temperature > THERMAL.restartLimit) {
        return {
          status: 'BadConditionNotMet',
          message: `Motor temperature above restart limit (${THERMAL.restartLimit} °C)`,
        };
      }
      if (method === 'Abort') this.abortReason = 'OPERATOR';
      this.setState(tr.to);
      return { status: 'Good' };
    }

    switch (method) {
      case 'SetSpeed': {
        const v = Number(args[0]);
        if (!Number.isFinite(v) || v < DRIVE.minSpeed || v > DRIVE.maxSpeed) {
          return { status: 'BadOutOfRange', message: `Setpoint must be ${DRIVE.minSpeed}–${DRIVE.maxSpeed} m/s` };
        }
        this.speedSetpoint = v;
        return { status: 'Good' };
      }
      case 'ReportInspection': {
        const tid = Number(args[0]);
        const verdict = args[1] as Verdict;
        this.counters.inspected++;
        const entry = this.tracking.find((e) => e.tid === tid);
        if (!entry) return { status: 'BadNodeIdUnknown', message: `Tracking id ${tid} has left the window` };
        entry.verdict = verdict;
        return { status: 'Good' };
      }
      case 'SetEStop': {
        const engaged = Boolean(args[0]);
        if (engaged !== this.estop) this.log(engaged ? 'E-stop ES-001 pressed' : 'E-stop ES-001 released');
        this.estop = engaged;
        return { status: 'Good' };
      }
      case 'SetFault': {
        const name = String(args[0]);
        if (!(name in this.faults)) return { status: 'BadNodeIdUnknown', message: `Unknown fault ${name}` };
        (this.faults as unknown as Record<string, unknown>)[name] = args[1];
        return { status: 'Good' };
      }
    }
    return { status: 'BadMethodInvalid', message: `Unknown method ${method}` };
  }

  // ───────────────────────────── scan cycle ─────────────────────────────

  step(dt = 0.02): void {
    this.readInputs();
    this.scan(dt);
    const h = dt / SUBSTEPS;
    for (let k = 0; k < SUBSTEPS; k++) this.integrate(h);
    this.t += dt;
  }

  private setState(s: PackML): void {
    if (s === this.state) return;
    this.log(`State ${STATE_NAME[this.state]} → ${STATE_NAME[s]}`);
    this.state = s;
    this.stateTime = 0;
  }

  private log(text: string): void {
    this.events.push({ t: this.t, text });
    if (this.events.length > 200) this.events.shift();
  }

  private beamBlocked(x: number): boolean {
    for (const it of this.items) {
      if (it.phase === 'falling') continue;
      if (Math.abs(it.x - x) < G.itemLength / 2 && Math.abs(it.z) < G.beltWidth / 2 + 0.01) return true;
    }
    return false;
  }

  private readInputs(): void {
    SENSOR_IDS.forEach((id, k) => {
      const raw = this.faults.sensorFail !== id && this.beamBlocked(SENSOR_X[id]);
      if (raw === this.raw[k]) this.pe[k] = raw; // one-scan debounce
      this.raw[k] = raw;
    });
  }

  private scan(dt: number): void {
    this.stateTime += dt;

    // Belt speed from encoder counts over a 100 ms window
    this.encHistory.push(this.encoderCount);
    if (this.encHistory.length > 6) this.encHistory.shift();
    const n = this.encHistory.length - 1;
    this.speedActual = n > 0 ? ((this.encHistory[n] - this.encHistory[0]) * METERS_PER_COUNT) / (n * dt) : 0;

    // Protective functions
    const aborting = this.state === PackML.Aborting || this.state === PackML.Aborted;
    if (this.estop && !aborting) {
      this.abortReason = 'ESTOP';
      this.setState(PackML.Aborting);
    } else if (this.temperature >= THERMAL.trip && !aborting) {
      this.abortReason = 'OVERTEMP';
      this.log(`Motor over-temperature trip at ${this.temperature.toFixed(1)} °C`);
      this.setState(PackML.Aborting);
    }

    // State machine timing
    switch (this.state) {
      case PackML.Starting:
        if (this.stateTime >= 1.0) this.setState(PackML.Execute); // start-up warning period
        break;
      case PackML.Unholding:
        if (this.stateTime >= 0.5) this.setState(PackML.Execute);
        break;
      case PackML.Resetting:
        if (this.stateTime >= 0.5) this.setState(PackML.Idle);
        break;
      case PackML.Clearing:
        if (this.stateTime >= 0.5) {
          this.abortReason = 'NONE';
          this.setState(PackML.Stopped);
        }
        break;
      case PackML.Stopping:
        if (this.rampSetpoint === 0 && this.speedActual < 0.005) this.setState(PackML.Stopped);
        break;
      case PackML.Holding:
        if (this.rampSetpoint === 0 && this.speedActual < 0.005) this.setState(PackML.Held);
        break;
      case PackML.Aborting:
        if (this.omega < 1) this.setState(PackML.Aborted);
        break;
    }

    // Speed reference ramp
    const target = this.state === PackML.Execute ? this.speedSetpoint : 0;
    const dv = DRIVE.accel * dt;
    this.rampSetpoint = clamp(this.rampSetpoint + clamp(target - this.rampSetpoint, -dv, dv), 0, DRIVE.maxSpeed);

    // Speed controller: feed-forward + PI on encoder speed
    const driveEnabled =
      this.state === PackML.Execute || this.state === PackML.Stopping || this.state === PackML.Holding;
    if (driveEnabled && (this.rampSetpoint > 0 || this.speedActual > 0.005)) {
      const err = this.rampSetpoint - this.speedActual;
      this.integral = clamp(this.integral + DRIVE.ki * err * dt, -0.3, 0.3);
      this.duty = clamp(this.rampSetpoint / V_NO_LOAD + DRIVE.kp * err + this.integral, 0, 1);
    } else {
      this.duty = 0;
      this.integral = 0;
    }

    // Upstream indexer places a carton every ~pitch of belt travel
    if (this.state === PackML.Execute && this.beltDistance >= this.nextSpawnAt) {
      const laneClear = this.items.every(
        (it) => it.phase === 'falling' || it.x > G.spawnX + G.itemLength + 0.02,
      );
      if (laneClear) {
        const defect = this.rand() < this.faults.defectRate;
        if (defect) this.truth.defectsProduced++;
        this.items.push({ id: this.nextItemId++, x: G.spawnX, y: 0, z: 0, vy: 0, defect, phase: 'conveying', dest: null });
        this.nextSpawnAt = this.beltDistance + G.pitch * (0.85 + 0.3 * this.rand());
      }
    }

    // Sensor edges
    const rise = (k: number) => this.pe[k] && !this.peLast[k];
    const fall = (k: number) => !this.pe[k] && this.peLast[k];

    if (rise(0)) this.counters.infeed++;

    if (rise(1)) {
      const tid = this.nextTid++;
      this.tracking.push({ tid, verdict: 'PENDING', enc: this.encoderCount });
      this.inspectionRequest = tid;
      if (this.autoInspect > 0) this.autoVerdict(tid);
    }

    const windowCounts = INSPECTION.trackingWindow / METERS_PER_COUNT;
    while (this.tracking.length && this.encoderCount - this.tracking[0].enc > windowCounts) {
      const lost = this.tracking.shift()!;
      this.log(`Tracking ${lost.tid} expired before reject station`);
    }

    if (rise(2)) {
      const head = this.tracking.shift();
      if (head && head.verdict !== 'GOOD') {
        this.pusherQueue.push(this.encoderCount + PUSH_DELAY_COUNTS);
        if (head.verdict !== 'DEFECT') this.log(`Tracking ${head.tid}: ${head.verdict} → fail-safe reject`);
      }
    }

    if (fall(3)) this.counters.outfeed++;

    if (this.pusherQueue.length && this.pusherPhase === 'idle' && this.encoderCount >= this.pusherQueue[0]) {
      this.pusherQueue.shift();
      this.pusherPhase = 'extending';
      this.pusherTimer = 0;
    }

    this.peLast = [...this.pe];

    // Stack light HL-001
    const flash = Math.floor(this.t * 2) % 2 === 0;
    const s = this.state;
    this.lights.green = s === PackML.Execute || (s === PackML.Starting && flash);
    this.lights.amber =
      s === PackML.Idle ||
      s === PackML.Stopped ||
      s === PackML.Resetting ||
      s === PackML.Clearing ||
      s === PackML.Stopping ||
      ((s === PackML.Held || s === PackML.Holding || s === PackML.Unholding) && flash);
    this.lights.red = s === PackML.Aborted || s === PackML.Aborting;
    this.lights.buzzer = s === PackML.Starting;
  }

  private autoVerdict(tid: number): void {
    const entry = this.tracking.find((e) => e.tid === tid);
    const item = this.items.find((it) => Math.abs(it.x - SENSOR_X.PE201) < G.itemLength);
    if (!entry || !item) return;
    const correct = this.rand() < this.autoInspect;
    entry.verdict = item.defect === correct ? 'DEFECT' : 'GOOD';
    this.counters.inspected++;
  }

  // ───────────────────────────── physics ─────────────────────────────

  private integrate(h: number): void {
    // Progressive faults: slip builds up over ~1.5 s, wear grows slowly and is repaired quickly
    this.slipActual += (this.faults.slip - this.slipActual) * Math.min(1, h / 1.5);
    const dw = 0.05 * h;
    this.wearActual += clamp(this.faults.bearingWear - this.wearActual, -dw * 10, dw);

    // Load reflected to the motor shaft
    let drag = BELT.baseDrag;
    for (const it of this.items) {
      if (it.phase === 'conveying') drag += BELT.muCarry * G.itemMass * GRAVITY;
      else if (it.phase === 'stopped') drag += BELT.muSlide * G.itemMass * GRAVITY;
    }
    const tLoad = (drag * G.rollerRadius) / (M.gearRatio * M.gearEfficiency);
    const tCoulomb = M.Tc * (1 + 5 * this.wearActual);

    // Armature current: exact solution of the electrical pole with ω frozen over h
    const v = this.duty * M.supplyVoltage;
    const iss = (v - M.Ke * this.omega) / M.R;
    this.current = iss + (this.current - iss) * Math.exp((-M.R * h) / M.L);

    // Rotor dynamics with static friction
    const tMotor = M.Kt * this.current;
    if (this.omega <= 1e-6 && tMotor <= tCoulomb + tLoad) {
      this.omega = 0;
    } else {
      const tResist = M.b * this.omega + tCoulomb + tLoad;
      this.omega = Math.max(0, this.omega + ((tMotor - tResist) / M.J) * h);
    }

    const omegaRoller = this.omega / M.gearRatio;
    this.rollerAngle = (this.rollerAngle + omegaRoller * h) % (2 * Math.PI);
    this.encoderAcc += ((omegaRoller * h) / (2 * Math.PI)) * COUNTS_PER_REV;
    this.beltSpeed = omegaRoller * G.rollerRadius * (1 - this.slipActual);
    this.beltDistance += this.beltSpeed * h;

    // Winding temperature
    const pLoss = this.current * this.current * M.R;
    this.temperature += ((pLoss - (this.temperature - THERMAL.ambient) / THERMAL.Rth) / THERMAL.Cth) * h;

    this.updatePusher(h);
    this.moveItems(h);
  }

  private updatePusher(h: number): void {
    const stroke = PUSHER.extendedZ - PUSHER.retractedZ;
    switch (this.pusherPhase) {
      case 'extending':
        this.pusherZ += (stroke / PUSHER.strokeTime) * h;
        if (this.pusherZ >= PUSHER.extendedZ) {
          this.pusherZ = PUSHER.extendedZ;
          this.pusherPhase = 'dwell';
          this.pusherTimer = 0;
        }
        break;
      case 'dwell':
        this.pusherTimer += h;
        if (this.pusherTimer >= PUSHER.dwell) this.pusherPhase = 'retracting';
        break;
      case 'retracting':
        this.pusherZ -= (stroke / PUSHER.retractTime) * h;
        if (this.pusherZ <= PUSHER.retractedZ) {
          this.pusherZ = PUSHER.retractedZ;
          this.pusherPhase = 'idle';
        }
        break;
    }
  }

  private moveItems(h: number): void {
    const L = G.itemLength;
    const W = G.itemWidth;
    let ahead: Item | null = null; // nearest downstream carton still on the belt

    // Items are kept in placement order, i.e. downstream first
    for (const it of this.items) {
      switch (it.phase) {
        case 'conveying':
        case 'stopped': {
          const free = it.x + this.beltSpeed * h;
          let limit = Infinity;
          if (this.faults.jam && it.x <= G.jamX + 1e-6) limit = G.jamX;
          if (ahead) limit = Math.min(limit, ahead.x - L - ACCUMULATION_GAP);
          const nx = Math.min(free, limit);
          it.phase = nx < free - 1e-9 ? 'stopped' : 'conveying';
          it.x = Math.max(it.x, nx);

          if (
            this.pusherPhase === 'extending' &&
            Math.abs(it.x - G.pusherX) < 0.06 &&
            this.pusherZ + 0.004 >= it.z - W / 2
          ) {
            it.phase = 'rejecting';
          } else if (it.x > G.length + G.rollerRadius) {
            it.phase = 'falling';
            it.dest = 'outfeed';
          } else {
            ahead = it;
          }
          break;
        }
        case 'rejecting':
          it.z = Math.max(it.z, this.pusherZ + 0.004 + W / 2);
          if (it.z > G.beltWidth / 2 + W / 2 + 0.03) {
            it.phase = 'falling';
            it.dest = 'reject';
          }
          break;
        case 'falling':
          it.vy -= GRAVITY * h;
          it.y += it.vy * h;
          if (it.dest === 'outfeed') it.x += 0.25 * h;
          else it.z += 0.15 * h;
          break;
      }
    }

    // Cartons that reached the bottom of a bin leave the model
    this.items = this.items.filter((it) => {
      if (it.y > -0.25) return true;
      if (it.dest === 'reject') {
        this.counters.rejected++;
        if (!it.defect) this.truth.falseRejects++;
      } else if (it.defect) {
        this.truth.escapedDefects++;
      }
      return false;
    });
  }

  // ───────────────────────────── outputs ─────────────────────────────

  private gauss(): number {
    const u = 1 - this.rand();
    const v = this.rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Process image published to the twin (values as a field device would report them). */
  readTags(): Record<string, TagValue> {
    const tags: Record<string, TagValue> = {
      'Status.State': this.state,
      'Status.StateName': STATE_NAME[this.state],
      'Status.AbortReason': this.abortReason,
      'Drive.SpeedSetpoint': this.speedSetpoint,
      'Drive.SpeedRamp': this.rampSetpoint,
      'Drive.SpeedActual': this.speedActual,
      'Drive.Duty': this.duty * 100,
      'Drive.MotorCurrent': this.current + (this.omega > 0 ? this.gauss() * 0.03 : 0),
      'Drive.MotorTemp': Math.round((this.temperature + this.gauss() * 0.05) * 10) / 10,
      'Drive.MotorSpeed': (this.omega * 60) / (2 * Math.PI),
      'Sensors.EncoderCount': this.encoderCount,
      'Actuators.YV301': this.pusherPhase === 'extending' || this.pusherPhase === 'dwell',
      'Actuators.HL001_Red': this.lights.red,
      'Actuators.HL001_Amber': this.lights.amber,
      'Actuators.HL001_Green': this.lights.green,
      'Actuators.HL001_Buzzer': this.lights.buzzer,
      'Safety.ES001': this.estop,
      'Counters.Infeed': this.counters.infeed,
      'Counters.Inspected': this.counters.inspected,
      'Counters.Rejected': this.counters.rejected,
      'Counters.Outfeed': this.counters.outfeed,
      'Tracking.QueueLength': this.tracking.length,
      'Inspection.RequestId': this.inspectionRequest,
      'Simulation.SimTime': this.t,
      'Simulation.BeltSpeedTrue': this.beltSpeed,
      'Simulation.Slip': this.slipActual,
      'Simulation.BearingWear': this.wearActual,
      'Simulation.Jam': this.faults.jam,
      'Simulation.SensorFault': this.faults.sensorFail,
      'Simulation.CameraFail': this.faults.cameraFail,
      'Simulation.DefectRate': this.faults.defectRate,
      'Simulation.EscapedDefects': this.truth.escapedDefects,
      'Simulation.FalseRejects': this.truth.falseRejects,
    };
    SENSOR_IDS.forEach((id, k) => (tags[`Sensors.${id}`] = this.pe[k]));
    return tags;
  }
}
