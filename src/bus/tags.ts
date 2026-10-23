/** Plant information model — OPC UA-style address space following the ISA-95 hierarchy. */

export type DataType = 'Boolean' | 'Int32' | 'UInt32' | 'Double' | 'String';

export interface TagDef {
  path: string;
  type: DataType;
  desc: string;
  unit?: string;
  decimals?: number;
  writable?: boolean;
}

export const ENDPOINT = 'plant://line1-conveyor01';
export const NAMESPACE = 'ns=2;s=DemoPlant.Area1.Line1.Conveyor01';
export const nodeId = (path: string) => `${NAMESPACE}.${path}`;

export const TAG_DEFS: TagDef[] = [
  { path: 'Status.State', type: 'Int32', desc: 'PackML state number (ISA-TR88.00.02)' },
  { path: 'Status.StateName', type: 'String', desc: 'PackML state name' },
  { path: 'Status.AbortReason', type: 'String', desc: 'Cause of the last abort' },

  { path: 'Drive.SpeedSetpoint', type: 'Double', unit: 'm/s', decimals: 3, writable: true, desc: 'Belt speed setpoint' },
  { path: 'Drive.SpeedRamp', type: 'Double', unit: 'm/s', decimals: 3, desc: 'Ramped speed reference' },
  { path: 'Drive.SpeedActual', type: 'Double', unit: 'm/s', decimals: 3, desc: 'Belt speed from ENC-001 (drive roller)' },
  { path: 'Drive.Duty', type: 'Double', unit: '%', decimals: 1, desc: 'M-001 PWM duty' },
  { path: 'Drive.MotorCurrent', type: 'Double', unit: 'A', decimals: 2, desc: 'M-001 armature current' },
  { path: 'Drive.MotorTemp', type: 'Double', unit: '°C', decimals: 1, desc: 'TT-001 winding temperature (PT100)' },
  { path: 'Drive.MotorSpeed', type: 'Double', unit: 'rpm', decimals: 0, desc: 'M-001 shaft speed' },

  { path: 'Sensors.PE101', type: 'Boolean', desc: 'Diffuse photo-eye, infeed (24 V PNP)' },
  { path: 'Sensors.PE201', type: 'Boolean', desc: 'Diffuse photo-eye, vision trigger (24 V PNP)' },
  { path: 'Sensors.PE301', type: 'Boolean', desc: 'Diffuse photo-eye, reject station (24 V PNP)' },
  { path: 'Sensors.PE401', type: 'Boolean', desc: 'Diffuse photo-eye, outfeed (24 V PNP)' },
  { path: 'Sensors.EncoderCount', type: 'UInt32', unit: 'cnt', desc: 'ENC-001, 600 PPR ×4 quadrature' },

  { path: 'Actuators.YV301', type: 'Boolean', desc: 'Reject pusher solenoid valve' },
  { path: 'Actuators.HL001_Red', type: 'Boolean', desc: 'Stack light — red' },
  { path: 'Actuators.HL001_Amber', type: 'Boolean', desc: 'Stack light — amber' },
  { path: 'Actuators.HL001_Green', type: 'Boolean', desc: 'Stack light — green' },
  { path: 'Actuators.HL001_Buzzer', type: 'Boolean', desc: 'Stack light — start-up horn' },

  { path: 'Safety.ES001', type: 'Boolean', desc: 'Emergency stop, true = engaged' },

  { path: 'Counters.Infeed', type: 'UInt32', desc: 'Cartons counted at PE-101' },
  { path: 'Counters.Inspected', type: 'UInt32', desc: 'Inspection results received' },
  { path: 'Counters.Rejected', type: 'UInt32', desc: 'Cartons in reject bin' },
  { path: 'Counters.Outfeed', type: 'UInt32', desc: 'Cartons counted at PE-401' },
  { path: 'Tracking.QueueLength', type: 'Int32', desc: 'Cartons tracked between vision and reject' },
  { path: 'Inspection.RequestId', type: 'UInt32', desc: 'Latest tracking id awaiting inspection' },

  { path: 'Simulation.SimTime', type: 'Double', unit: 's', decimals: 1, desc: 'Virtual plant only — simulation time' },
  { path: 'Simulation.BeltSpeedTrue', type: 'Double', unit: 'm/s', decimals: 3, desc: 'Virtual plant only — true belt speed' },
  { path: 'Simulation.Slip', type: 'Double', decimals: 3, desc: 'Virtual plant only — injected slip' },
  { path: 'Simulation.BearingWear', type: 'Double', decimals: 2, desc: 'Virtual plant only — injected wear' },
  { path: 'Simulation.Jam', type: 'Boolean', desc: 'Virtual plant only — zone 2 obstruction' },
  { path: 'Simulation.SensorFault', type: 'String', desc: 'Virtual plant only — failed photo-eye' },
  { path: 'Simulation.CameraFail', type: 'Boolean', desc: 'Virtual plant only — camera failure' },
  { path: 'Simulation.DefectRate', type: 'Double', decimals: 2, desc: 'Virtual plant only — upstream defect rate' },
  { path: 'Simulation.EscapedDefects', type: 'UInt32', desc: 'Virtual plant only — defects that reached outfeed' },
  { path: 'Simulation.FalseRejects', type: 'UInt32', desc: 'Virtual plant only — good cartons rejected' },
];

export const TAG_BY_PATH = new Map(TAG_DEFS.map((d) => [d.path, d]));

export function formatTag(path: string, value: unknown): string {
  const def = TAG_BY_PATH.get(path);
  if (typeof value === 'number') {
    const d = def?.decimals ?? (Number.isInteger(value) ? 0 : 2);
    return value.toFixed(d);
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value ?? '—');
}
