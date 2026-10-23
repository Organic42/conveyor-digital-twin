/**
 * Plant controller process. Runs the virtual machine on its own thread with a fixed 20 ms
 * scan and publishes the process image at 25 Hz. The twin can only reach it through messages.
 */
import { Plant } from './model';
import { VIBRATION } from './params';
import type { CallRequest, PlantFrame } from '../bus/protocol';

const SCAN = 0.02;
const PUBLISH_EVERY = 2; // scans
const VIBRATION_EVERY = Math.round(VIBRATION.periodS / SCAN / PUBLISH_EVERY); // publishes

const ctx = self as unknown as Worker;
const plant = new Plant({ seed: (Date.now() & 0xffff) + 1 });

let seq = 0;
let scans = 0;
let last = performance.now();
let backlog = 0;

function publish(): void {
  const data = (seq + 1) % VIBRATION_EVERY === 0 ? plant.vibrationBlock() : null;
  const tags = plant.readTags();
  const frame: PlantFrame = {
    type: 'frame',
    seq: ++seq,
    ts: Date.now(),
    tags,
    events: plant.events.splice(0),
    vibration: data ? { fs: VIBRATION.fs, rpm: Number(tags['Drive.MotorSpeed']), data } : undefined,
    items: plant.items.map(({ id, x, y, z, defect, defectKind, defectFace, phase }) => ({
      id,
      x,
      y,
      z,
      defect,
      defectKind,
      defectFace,
      phase,
    })),
    pusherZ: plant.pusherZ,
    beltDistance: plant.beltDistance,
    beltSpeed: plant.beltSpeed,
    rollerAngle: plant.rollerAngle,
  };
  ctx.postMessage(frame);
}

setInterval(() => {
  const now = performance.now();
  backlog += Math.min(now - last, 250) / 1000;
  last = now;
  while (backlog >= SCAN) {
    plant.step(SCAN);
    backlog -= SCAN;
    if (++scans % PUBLISH_EVERY === 0) publish();
  }
}, 5);

ctx.onmessage = (e: MessageEvent<CallRequest>) => {
  const msg = e.data;
  if (msg.type !== 'call') return;
  ctx.postMessage({ type: 'reply', id: msg.id, result: plant.call(msg.method, msg.args) });
};
