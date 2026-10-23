/**
 * Reference plant: 1.2 m benchtop inspection & reject conveyor.
 * All values in SI units. Positions are measured along the belt from the tail (infeed) roller.
 */

export const GEOMETRY = {
  length: 1.2, // pulley centre distance [m]
  beltWidth: 0.16, // [m]
  deckHeight: 0.78, // top of belt above floor [m]
  rollerRadius: 0.025, // drive and tail roller [m]
  itemLength: 0.06, // carton dimensions [m]
  itemWidth: 0.05,
  itemHeight: 0.045,
  itemMass: 0.15, // [kg]
  pitch: 0.3, // nominal spacing set by the upstream indexer [m]
  spawnX: 0.04, // carton centre when placed on the belt [m]
  jamX: 0.72, // obstruction point used by the jam fault (zone 2) [m]
  pusherX: 0.89, // reject pusher plate centre [m]
} as const;

export const SENSOR_IDS = ['PE101', 'PE201', 'PE301', 'PE401'] as const;
export type SensorId = (typeof SENSOR_IDS)[number];

/** Photo-eye beam positions [m]. */
export const SENSOR_X: Record<SensorId, number> = {
  PE101: 0.15, // infeed
  PE201: 0.55, // vision station trigger
  PE301: 0.84, // reject station trigger
  PE401: 1.12, // outfeed
};

export const SENSOR_LABEL: Record<SensorId, string> = {
  PE101: 'PE-101',
  PE201: 'PE-201',
  PE301: 'PE-301',
  PE401: 'PE-401',
};

/** M-001: 24 V DC permanent-magnet gearmotor, 60 W class. */
export const MOTOR = {
  supplyVoltage: 24, // [V]
  R: 1.2, // armature resistance [Ω]
  L: 0.002, // armature inductance [H]
  Kt: 0.055, // torque constant [N·m/A]
  Ke: 0.055, // back-EMF constant [V·s/rad]
  J: 2.0e-4, // rotor + reflected load inertia [kg·m²]
  b: 2.0e-4, // viscous friction [N·m·s/rad]
  Tc: 0.01, // Coulomb friction [N·m]
  gearRatio: 20,
  gearEfficiency: 0.85,
  ratedCurrent: 2.5, // [A]
} as const;

/** Belt drag on the slider bed. */
export const BELT = {
  baseDrag: 4.0, // empty belt [N]
  muCarry: 0.3, // per conveyed carton
  muSlide: 0.55, // belt sliding underneath a stopped carton
} as const;

/** TT-001 winding temperature, first-order thermal network. */
export const THERMAL = {
  ambient: 25, // [°C]
  Rth: 12, // winding to ambient [K/W]
  Cth: 7.5, // [J/K] → τ = 90 s. Accelerated for the demo; a real motor is ≈ 20 min.
  initial: 38,
  highAlarm: 80,
  highAlarmReset: 75,
  trip: 90,
  restartLimit: 75,
} as const;

export const DRIVE = {
  minSpeed: 0.1, // [m/s]
  maxSpeed: 0.45,
  designSpeed: 0.4, // basis for the OEE ideal cycle time
  defaultSpeed: 0.3,
  accel: 0.5, // setpoint ramp [m/s²]
  kp: 1.2, // speed PI [duty per m/s]
  ki: 8,
} as const;

/** ENC-001 incremental encoder on the drive roller. */
export const ENCODER = { ppr: 600, quadrature: 4 } as const;

/** YV-301 solenoid valve + pneumatic pusher. z is across the belt (+z = operator side). */
export const PUSHER = {
  retractedZ: -0.115,
  extendedZ: 0.115,
  strokeTime: 0.15, // [s]
  dwell: 0.08,
  retractTime: 0.18,
} as const;

export const INSPECTION = {
  trackingWindow: 0.45, // max encoder travel PE-201 → PE-301 before a tracking entry is dropped [m]
} as const;

/** Ideal cycle time used by OEE performance [s/item]. */
export const IDEAL_CYCLE = GEOMETRY.pitch / DRIVE.designSpeed;
