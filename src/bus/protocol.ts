/** Messages exchanged between the plant controller (worker) and the twin over the plant link. */
import type { CallResult, ItemPhase, PlantEvent, TagValue } from '../plant/model';
import type { DefectKind, Face } from '../plant/params';

export interface ItemSnapshot {
  id: number;
  x: number;
  y: number;
  z: number;
  defect: boolean;
  defectKind: DefectKind | null;
  defectFace: Face | null;
  phase: ItemPhase;
}

/** VT-001 waveform block (acceleration, m/s²). */
export interface VibrationBlock {
  fs: number;
  rpm: number;
  data: Float32Array;
}

/** Cyclic publish: the full process image plus the scene state of the virtual machine. */
export interface PlantFrame {
  type: 'frame';
  seq: number;
  ts: number; // source timestamp, ms since epoch
  tags: Record<string, TagValue>;
  events: PlantEvent[];
  /** Present once per second, when the vibration sensor delivers a block. */
  vibration?: VibrationBlock;
  // Scene state — what a camera looking at the real machine would show.
  items: ItemSnapshot[];
  pusherZ: number;
  beltDistance: number;
  beltSpeed: number;
  rollerAngle: number;
}

export interface CallReply {
  type: 'reply';
  id: number;
  result: CallResult;
}

export interface CallRequest {
  type: 'call';
  id: number;
  method: string;
  args: unknown[];
}

export type PlantMessage = PlantFrame | CallReply;
