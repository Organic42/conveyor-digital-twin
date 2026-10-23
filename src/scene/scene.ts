/**
 * 3D view of Conveyor 01, built to the reference dimensions in plant/params.ts.
 * Conveyor-local coordinates: x along the belt from the tail roller, y up from the floor,
 * z across the belt (+z = operator side). The conveyor group is centred on the world origin.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  CAMERAS,
  GEOMETRY as G,
  PUSHER,
  SENSOR_IDS,
  SENSOR_LABEL,
  SENSOR_X,
  type CameraId,
  type DefectKind,
  type Face,
  type SensorId,
} from '../plant/params';
import type { PlantFrame } from '../bus/protocol';

export type DeviceId = SensorId | CameraId | 'M001' | 'VT001' | 'ENC001' | 'YV301' | 'HL001' | 'ES001' | 'BELT';
export type ViewName = 'iso' | 'side' | 'top' | 'inspect';

/** Where the twin believes a carton is (drawn as a wireframe). */
export interface GhostEstimate {
  id: number;
  x: number;
  overdue: boolean;
}

export type TagValues = Partial<Record<DeviceId, { text: string; abn?: boolean }>>;

export interface SceneTheme {
  background: string;
  floor: string;
  grid1: string;
  grid2: string;
}

const LAYER_OVERLAY = 1; // twin estimates, beams, zone highlights — never seen by the inspection camera
const TILE = 0.2; // belt texture repeat length [m]
const L = G.length;
const W = G.beltWidth;
const Y = G.deckHeight;
const R = G.rollerRadius;
const ROLLER_Y = Y - R - 0.002;
const CAM_X = SENSOR_X.PE201 + 0.01;
/** Carton centre when the vision tunnel fires (leading edge at PE-201 plus link latency). */
const TUNNEL_X = SENSOR_X.PE201 - 0.015;
const SX = SENSOR_IDS.map((id) => SENSOR_X[id]);

function mat(color: number, rough = 0.6, metal = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
}

const M = {
  alu: mat(0xb9bec4, 0.35, 0.6),
  aluDark: mat(0x7c838a, 0.45, 0.5),
  slot: mat(0x55595e, 0.6, 0.3),
  steel: mat(0xa3a9af, 0.28, 0.85),
  rubber: mat(0x2a2e32, 0.95, 0),
  black: mat(0x1d2024, 0.55, 0.1),
  sensor: mat(0x3a4048, 0.5, 0.2),
  carton: mat(0xb5895a, 0.88, 0),
  tape: mat(0xc9a676, 0.6, 0),
  label: mat(0xf1f1ee, 0.7, 0),
  defectLabel: mat(0xc62828, 0.6, 0),
  ink: mat(0x2747a8, 0.35, 0),
  bin: mat(0x58636d, 0.7, 0.1),
  safety: mat(0xf0bf00, 0.5, 0),
  mushroom: mat(0xc4161c, 0.35, 0),
  valve: mat(0x2f5f8b, 0.45, 0.3),
};
const MOTOR_COLD = new THREE.Color(0x3f4c59);
const MOTOR_HOT = new THREE.Color(0xc4532a);

const box = (w: number, h: number, d: number, m: THREE.Material) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
};

/** Cylinder whose axis is along z. */
const cylZ = (r: number, len: number, m: THREE.Material, seg = 32) => {
  const g = new THREE.CylinderGeometry(r, r, len, seg);
  g.rotateX(Math.PI / 2);
  const mesh = new THREE.Mesh(g, m);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
};

const cylY = (r: number, h: number, m: THREE.Material, seg = 24) => {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), m);
  mesh.castShadow = true;
  return mesh;
};

function beltTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#3a3f44';
  g.fillRect(0, 0, 256, 128);
  for (let i = 0; i < 2200; i++) {
    const v = 50 + Math.random() * 18;
    g.fillStyle = `rgb(${v},${v + 4},${v + 8})`;
    g.fillRect(Math.random() * 256, Math.random() * 128, 2, 1);
  }
  g.fillStyle = '#555b61'; // splice line so motion is readable
  g.fillRect(0, 0, 6, 128);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(L / TILE, 1);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

interface TagElement {
  root: HTMLElement;
  value: HTMLElement;
  anchor: CSS2DObject;
}

function makeLabel(text: string, cls = ''): TagElement {
  const root = document.createElement('div');
  root.className = `tag-label ${cls}`;
  const name = document.createElement('b');
  name.textContent = text;
  const value = document.createElement('span');
  value.className = 'tv';
  root.append(name, value);
  return { root, value, anchor: new CSS2DObject(root) };
}

export class TwinScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  onPick: (id: DeviceId | null) => void = () => {};

  private readonly labels: CSS2DRenderer;
  private readonly controls: OrbitControls;
  private readonly conveyor = new THREE.Group();
  private readonly beltTex = beltTexture();
  private readonly rollers: THREE.Object3D[] = [];
  private readonly sensorLed = {} as Record<SensorId, THREE.MeshStandardMaterial>;
  private readonly sensorBeam = {} as Record<SensorId, THREE.MeshBasicMaterial>;
  private readonly lamps: Record<'red' | 'amber' | 'green', THREE.MeshStandardMaterial>;
  private readonly labelObjects: CSS2DObject[] = [];
  private readonly tags = new Map<DeviceId, TagElement>();
  private readonly pickables: THREE.Object3D[] = [];
  private readonly items = new Map<number, THREE.Group>();
  private readonly ghosts = new Map<number, THREE.LineSegments>();
  private readonly ghostGeom: THREE.EdgesGeometry;
  private readonly ghostMat = new THREE.LineBasicMaterial({ color: 0x1f5fa0 });
  private readonly ghostOverdueMat = new THREE.LineBasicMaterial({ color: 0xe07b00 });
  private readonly itemGeom = new THREE.BoxGeometry(G.itemLength, G.itemHeight, G.itemWidth);
  private readonly inspectionCams: { id: CameraId; cam: THREE.PerspectiveCamera }[] = [];
  private readonly inspectionTarget: THREE.WebGLRenderTarget;
  readonly inspectionSize = { w: 128, h: 96 };
  private readonly ringLight: THREE.MeshStandardMaterial;
  private readonly valveLed: THREE.MeshStandardMaterial;
  private readonly motorMat = mat(0x3f4c59, 0.45, 0.35);
  private readonly zoneMats: THREE.MeshBasicMaterial[] = [];
  private readonly zones: THREE.Mesh[] = [];
  private readonly floorMat = new THREE.MeshStandardMaterial({ color: 0xc3c7cb, roughness: 0.95 });
  private grid: THREE.GridHelper;
  private readonly selection: THREE.BoxHelper;
  private pusherPlate!: THREE.Object3D;
  private pusherRod!: THREE.Object3D;
  private estopCap!: THREE.Object3D;
  private flash = 0;
  private tween: { from: THREE.Vector3; to: THREE.Vector3; tFrom: THREE.Vector3; tTo: THREE.Vector3; t: number } | null = null;
  private lastRender = performance.now();
  private showTwin = true;
  private readonly tmp = new THREE.Vector3();

  constructor(private readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    host.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'label-layer';
    host.appendChild(this.labels.domElement);

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.01, 40);
    this.camera.layers.enable(LAYER_OVERLAY);
    this.camera.position.set(1.15, 1.45, 1.35);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.72, 0);
    this.controls.enableDamping = true;
    this.controls.minDistance = 0.3;
    this.controls.maxDistance = 5;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.update();

    this.scene.background = new THREE.Color(0xd2d6da);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;

    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(1.6, 3.2, 2.0);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -1.4;
    sun.shadow.camera.right = 1.4;
    sun.shadow.camera.top = 1.4;
    sun.shadow.camera.bottom = -1.4;
    sun.shadow.bias = -0.0004;
    this.scene.add(sun, new THREE.HemisphereLight(0xffffff, 0x9aa0a6, 0.6));

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), this.floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.grid = new THREE.GridHelper(10, 40, 0xa5abb1, 0xb4b9be);
    this.grid.position.y = 0.001;
    this.scene.add(this.grid);

    this.conveyor.position.x = -L / 2;
    this.scene.add(this.conveyor);

    this.lamps = {
      red: new THREE.MeshStandardMaterial({ color: 0x5a1414, emissive: 0xff2a1a, emissiveIntensity: 0, roughness: 0.3 }),
      amber: new THREE.MeshStandardMaterial({ color: 0x5a4210, emissive: 0xffa200, emissiveIntensity: 0, roughness: 0.3 }),
      green: new THREE.MeshStandardMaterial({ color: 0x14401c, emissive: 0x2bff4a, emissiveIntensity: 0, roughness: 0.3 }),
    };
    this.ringLight = new THREE.MeshStandardMaterial({ color: 0xdfe6ee, emissive: 0xffffff, emissiveIntensity: 0.2 });
    this.valveLed = new THREE.MeshStandardMaterial({ color: 0x402a08, emissive: 0xffa200, emissiveIntensity: 0 });
    this.motorMat.emissive.copy(MOTOR_HOT);
    this.motorMat.emissiveIntensity = 0;

    this.buildFrame();
    this.buildZones();
    this.buildDrive();
    this.buildSensors();
    this.buildVisionStation();
    this.buildRejectStation();
    this.buildBins();
    this.buildStackLightAndControls();

    this.ghostGeom = new THREE.EdgesGeometry(
      new THREE.BoxGeometry(G.itemLength + 0.008, G.itemHeight + 0.008, G.itemWidth + 0.008),
    );

    // All tunnel cameras render side by side into one target → a single GPU readback per carton
    this.inspectionTarget = new THREE.WebGLRenderTarget(this.inspectionSize.w * this.inspectionCams.length, this.inspectionSize.h);

    this.selection = new THREE.BoxHelper(new THREE.Object3D(), 0x2d5f8b);
    this.selection.layers.set(LAYER_OVERLAY);
    this.selection.visible = false;
    this.scene.add(this.selection);

    this.bindPicking();
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  // ───────────────────────────── construction ─────────────────────────────

  private device(obj: THREE.Object3D, id: DeviceId, text: string, offset: THREE.Vector3, cls = ''): void {
    obj.userData.device = id;
    this.pickables.push(obj);
    const tag = makeLabel(text, cls);
    tag.anchor.position.copy(offset);
    obj.add(tag.anchor);
    this.labelObjects.push(tag.anchor);
    this.tags.set(id, tag);
  }

  private buildFrame(): void {
    const c = this.conveyor;
    const belt = box(L, 0.004, W, new THREE.MeshStandardMaterial({ map: this.beltTex, roughness: 0.92 }));
    belt.position.set(L / 2, Y - 0.002, 0);
    c.add(belt);
    this.device(belt, 'BELT', 'BELT', new THREE.Vector3(-0.42, 0.03, 0.12), 'minor');

    const ret = box(L, 0.004, W, M.rubber);
    ret.position.set(L / 2, ROLLER_Y - R - 0.002, 0);
    c.add(ret);
    const bed = box(L - 0.02, 0.006, W - 0.01, M.aluDark);
    bed.position.set(L / 2, Y - 0.008, 0);
    c.add(bed);

    for (const x of [0, L]) {
      const roller = new THREE.Group();
      roller.add(cylZ(R, W + 0.012, M.steel));
      const mark = box(0.006, 0.003, W + 0.014, M.black);
      mark.position.y = R;
      roller.add(mark);
      roller.position.set(x, ROLLER_Y, 0);
      c.add(roller);
      this.rollers.push(roller);
    }

    // Side frames: 2080-style aluminium profile with slot detail
    for (const s of [-1, 1]) {
      const z = s * (W / 2 + 0.011);
      const rail = box(L + 0.09, 0.07, 0.02, M.alu);
      rail.position.set(L / 2, Y - 0.036, z);
      c.add(rail);
      for (const dy of [-0.018, 0.018]) {
        const slot = box(L + 0.09, 0.006, 0.002, M.slot);
        slot.position.set(L / 2, Y - 0.036 + dy, z + s * 0.0105);
        c.add(slot);
      }
      for (const x of [-0.045, L + 0.045]) {
        const cap = box(0.004, 0.072, 0.022, M.black);
        cap.position.set(x, Y - 0.036, z);
        c.add(cap);
      }
    }

    // Stand
    const legH = Y - 0.071;
    for (const x of [0.07, L - 0.07]) {
      for (const s of [-1, 1]) {
        const leg = box(0.04, legH, 0.04, M.alu);
        leg.position.set(x, legH / 2, s * (W / 2 + 0.03));
        c.add(leg);
        const foot = cylY(0.022, 0.012, M.black);
        foot.position.set(x, 0.006, s * (W / 2 + 0.03));
        c.add(foot);
      }
      const cross = box(0.03, 0.03, W + 0.03, M.alu);
      cross.position.set(x, 0.22, 0);
      c.add(cross);
    }
    for (const s of [-1, 1]) {
      const rail = box(L - 0.14, 0.03, 0.03, M.alu);
      rail.position.set(L / 2, 0.22, s * (W / 2 + 0.03));
      c.add(rail);
    }
  }

  /** Translucent highlights over the three belt zones between photo-eyes (jam indication). */
  private buildZones(): void {
    for (let k = 1; k <= 3; k++) {
      const m = new THREE.MeshBasicMaterial({ color: 0xff8a00, transparent: true, opacity: 0.3, depthWrite: false });
      const len = SX[k] - SX[k - 1];
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(len, W + 0.02), m);
      plane.rotation.x = -Math.PI / 2;
      plane.position.set(SX[k - 1] + len / 2, Y + 0.0015, 0);
      plane.layers.set(LAYER_OVERLAY);
      plane.visible = false;
      this.conveyor.add(plane);
      this.zones[k] = plane;
      this.zoneMats[k] = m;
    }
  }

  private buildDrive(): void {
    const c = this.conveyor;
    const zFace = W / 2 + 0.021;
    const drive = new THREE.Group();
    const gearbox = box(0.075, 0.075, 0.055, this.motorMat);
    gearbox.position.set(0, 0, zFace + 0.0275);
    const motor = cylZ(0.032, 0.11, this.motorMat);
    motor.position.set(0, -0.005, zFace + 0.055 + 0.055);
    const endCap = cylZ(0.033, 0.012, M.black);
    endCap.position.set(0, -0.005, zFace + 0.171);
    const tbox = box(0.035, 0.022, 0.04, M.black);
    tbox.position.set(0, 0.038, zFace + 0.1);
    drive.add(gearbox, motor, endCap, tbox);
    drive.position.set(L, ROLLER_Y, 0);
    c.add(drive);
    this.device(drive, 'M001', 'M-001', new THREE.Vector3(0, 0.07, zFace + 0.1));

    // VT-001 accelerometer stud-mounted on the gearbox at the drive-end bearing
    const vt = new THREE.Group();
    const vtBody = cylY(0.007, 0.018, M.steel, 16);
    vtBody.position.y = 0.009;
    const vtCable = cylY(0.0025, 0.012, M.black, 8);
    vtCable.rotation.z = Math.PI / 2;
    vtCable.position.set(0.011, 0.013, 0);
    vt.add(vtBody, vtCable);
    vt.position.set(L + 0.012, ROLLER_Y + 0.0375, zFace + 0.02);
    c.add(vt);
    this.device(vt, 'VT001', 'VT-001', new THREE.Vector3(0.04, 0.05, 0.02), 'minor');

    const enc = new THREE.Group();
    const encBody = cylZ(0.02, 0.03, M.black);
    encBody.position.z = -(W / 2 + 0.036);
    const encShaft = cylZ(0.004, 0.02, M.steel);
    encShaft.position.z = -(W / 2 + 0.016);
    enc.add(encBody, encShaft);
    enc.position.set(L, ROLLER_Y, 0);
    c.add(enc);
    this.device(enc, 'ENC001', 'ENC-001', new THREE.Vector3(0, 0.045, -(W / 2 + 0.04)), 'minor');
  }

  private buildSensors(): void {
    for (const id of SENSOR_IDS) {
      const x = SENSOR_X[id];
      const g = new THREE.Group();
      const bracket = box(0.026, 0.004, 0.03, M.aluDark);
      bracket.position.set(0, 0.002, -(W / 2 + 0.018));
      const body = box(0.014, 0.034, 0.02, M.sensor);
      body.position.set(0, 0.021, -(W / 2 + 0.024));
      const ledMat = new THREE.MeshStandardMaterial({ color: 0x3a2a08, emissive: 0xffa200, emissiveIntensity: 0 });
      const led = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.004, 0.008), ledMat);
      led.position.set(0, 0.04, -(W / 2 + 0.024));
      const beamMat = new THREE.MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity: 0.35, depthWrite: false });
      // Diffuse sensor: the light spot reaches across the belt (drawn as an overlay only)
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.0011, 0.0011, W + 0.01, 6), beamMat);
      beam.rotation.x = Math.PI / 2;
      beam.position.set(0, 0.022, -0.01);
      beam.layers.set(LAYER_OVERLAY);
      g.add(bracket, body, led, beam);
      g.position.set(x, Y, 0);
      this.conveyor.add(g);
      this.sensorLed[id] = ledMat;
      this.sensorBeam[id] = beamMat;
      this.device(g, id, SENSOR_LABEL[id], new THREE.Vector3(0, 0.07, -(W / 2 + 0.024)));
    }
  }

  private buildVisionStation(): void {
    const g = new THREE.Group();
    const h = 0.29;
    for (const s of [-1, 1]) {
      const post = box(0.02, h, 0.02, M.alu);
      post.position.set(0, h / 2 - 0.01, s * (W / 2 + 0.045));
      g.add(post);
    }
    const bar = box(0.02, 0.02, W + 0.11, M.alu);
    bar.position.set(0, h - 0.01, 0);
    const mount = box(0.012, 0.03, 0.03, M.aluDark);
    mount.position.set(0, h - 0.035, 0);
    const cam = box(0.045, 0.035, 0.035, M.black);
    cam.position.set(0, 0.245, 0);
    const lens = cylY(0.011, 0.022, M.steel);
    lens.position.set(0, 0.217, 0);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.022, 0.004, 10, 32), this.ringLight);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(0, 0.207, 0);
    g.add(bar, mount, cam, lens, ring);
    g.position.set(CAM_X, Y, 0);
    this.conveyor.add(g);
    this.device(g, 'CAM201', 'CAM-201', new THREE.Vector3(0, h + 0.03, 0));
    this.addOptics('CAM201', new THREE.Vector3(CAM_X, Y + 0.225, 0), new THREE.Vector3(CAM_X, Y, 0), new THREE.Vector3(0, 0, -1));

    // Side and end cameras complete the tunnel (bottom face would need a belt-gap camera)
    const c = this.conveyor;
    const target = new THREE.Vector3(TUNNEL_X, Y + G.itemHeight / 2, 0);
    const endTarget = new THREE.Vector3(TUNNEL_X, Y + 0.02, 0);
    for (const s of [-1, 1] as const) {
      // Left camera sits a little upstream so the PE-201 body does not block its view
      const pos = new THREE.Vector3(TUNNEL_X - (s < 0 ? 0.035 : 0), Y + 0.035, s * 0.21);
      const id: CameraId = s < 0 ? 'CAM202' : 'CAM203';
      const arm = box(0.02, 0.012, 0.11, M.aluDark);
      arm.position.set(pos.x, Y - 0.075, s * 0.156);
      const post = box(0.014, 0.1, 0.014, M.alu);
      post.position.set(pos.x, Y - 0.03, pos.z);
      c.add(arm, post);
      this.tunnelCamera(id, pos, target);
    }
    const rail = box(0.4, 0.016, 0.016, M.alu);
    rail.position.set(TUNNEL_X, Y + h - 0.01, 0);
    c.add(rail);
    for (const s of [1, -1] as const) {
      const pos = new THREE.Vector3(TUNNEL_X + s * 0.17, Y + 0.17, 0);
      const rod = box(0.01, h - 0.19, 0.01, M.alu);
      rod.position.set(pos.x, Y + (h + 0.17) / 2, 0);
      c.add(rod);
      this.tunnelCamera(s > 0 ? 'CAM204' : 'CAM205', pos, endTarget);
    }
  }

  /** Camera body + ring light aimed at the carton, plus its inspection optics and illumination. */
  private tunnelCamera(id: CameraId, pos: THREE.Vector3, target: THREE.Vector3): void {
    const g = new THREE.Group();
    const body = box(0.03, 0.028, 0.04, M.black);
    body.position.z = -0.014;
    const lens = cylZ(0.008, 0.014, M.steel, 16);
    lens.position.z = 0.012;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.013, 0.0025, 8, 24), this.ringLight);
    ring.position.z = 0.02;
    g.add(body, lens, ring);
    g.position.copy(pos);
    this.conveyor.add(g);
    this.conveyor.updateMatrixWorld(true);
    g.lookAt(this.conveyor.localToWorld(target.clone()));
    // No visible tag (the tunnel is crowded); the anchor still positions the faceplate
    const label = CAMERAS.find((cam) => cam.id === id)!.label;
    this.device(g, id, label, new THREE.Vector3(0, 0.035, 0), 'anchor-only');
    this.addOptics(id, pos, target);
    const light = new THREE.PointLight(0xffffff, 0.035, 0.5, 2);
    light.position.copy(pos);
    this.conveyor.add(light);
  }

  private addOptics(id: CameraId, pos: THREE.Vector3, target: THREE.Vector3, up?: THREE.Vector3): void {
    const cam = new THREE.PerspectiveCamera(32, 4 / 3, 0.02, 1);
    if (up) cam.up.copy(up);
    cam.position.copy(pos).add(this.conveyor.position);
    cam.lookAt(target.clone().add(this.conveyor.position));
    this.inspectionCams.push({ id, cam });
  }

  private buildRejectStation(): void {
    const c = this.conveyor;
    const g = new THREE.Group();
    const yc = 0.026;
    const body = cylZ(0.017, 0.12, M.steel);
    body.position.set(0, yc, PUSHER.retractedZ - 0.074);
    const endCap = box(0.04, 0.04, 0.012, M.aluDark);
    endCap.position.set(0, yc, PUSHER.retractedZ - 0.14);
    const headCap = box(0.04, 0.04, 0.012, M.aluDark);
    headCap.position.set(0, yc, PUSHER.retractedZ - 0.014);
    const valve = box(0.026, 0.02, 0.035, M.valve);
    valve.position.set(0, yc + 0.03, PUSHER.retractedZ - 0.09);
    const coil = box(0.018, 0.018, 0.018, M.black);
    coil.position.set(0, yc + 0.049, PUSHER.retractedZ - 0.09);
    const led = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.004, 0.006), this.valveLed);
    led.position.set(0, yc + 0.06, PUSHER.retractedZ - 0.09);
    const bracket = box(0.05, 0.004, 0.16, M.aluDark);
    bracket.position.set(0, 0.0, PUSHER.retractedZ - 0.07);
    g.add(body, endCap, headCap, valve, coil, led, bracket);

    this.pusherRod = cylZ(0.005, 1, M.steel, 12);
    this.pusherRod.position.y = yc;
    this.pusherPlate = box(0.08, 0.035, 0.008, M.aluDark);
    this.pusherPlate.position.y = yc;
    g.add(this.pusherRod, this.pusherPlate);
    g.position.set(G.pusherX, Y, 0);
    c.add(g);
    this.device(g, 'YV301', 'YV-301', new THREE.Vector3(0, 0.1, PUSHER.retractedZ - 0.09));
    this.setPusher(PUSHER.retractedZ);
  }

  private buildBins(): void {
    const tray = (w: number, h: number, d: number) => {
      const g = new THREE.Group();
      const t = 0.004;
      const bottom = box(w, t, d, M.bin);
      bottom.position.y = -h / 2;
      const s1 = box(w, h, t, M.bin);
      s1.position.z = d / 2;
      const s2 = s1.clone();
      s2.position.z = -d / 2;
      const s3 = box(t, h, d, M.bin);
      s3.position.x = w / 2;
      const s4 = s3.clone();
      s4.position.x = -w / 2;
      g.add(bottom, s1, s2, s3, s4);
      return g;
    };
    const reject = tray(0.18, 0.1, 0.14);
    reject.position.set(G.pusherX, Y - 0.17, W / 2 + 0.11);
    const rejectStand = box(0.03, Y - 0.22, 0.03, M.aluDark);
    rejectStand.position.set(G.pusherX, (Y - 0.22) / 2, W / 2 + 0.11);
    const out = tray(0.2, 0.1, 0.2);
    out.position.set(L + 0.13, Y - 0.17, 0);
    const outStand = box(0.03, Y - 0.22, 0.03, M.aluDark);
    outStand.position.set(L + 0.13, (Y - 0.22) / 2, 0);
    this.conveyor.add(reject, rejectStand, out, outStand);
    const lr = makeLabel('REJECT', 'minor').anchor;
    lr.position.set(0, 0.07, 0.08);
    reject.add(lr);
    const lo = makeLabel('OUTFEED', 'minor').anchor;
    lo.position.set(0.05, 0.07, 0);
    out.add(lo);
    this.labelObjects.push(lr, lo);
  }

  private buildStackLightAndControls(): void {
    const c = this.conveyor;
    const tower = new THREE.Group();
    const pole = cylY(0.008, 0.2, M.alu);
    pole.position.y = 0.1;
    const base = cylY(0.024, 0.02, M.black);
    base.position.y = 0.21;
    tower.add(pole, base);
    (['green', 'amber', 'red'] as const).forEach((k, i) => {
      const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.036, 24), this.lamps[k]);
      seg.position.y = 0.24 + i * 0.038;
      tower.add(seg);
    });
    const cap = cylY(0.023, 0.012, M.black);
    cap.position.y = 0.24 + 3 * 0.038 - 0.012;
    tower.add(cap);
    tower.position.set(L - 0.12, Y - 0.002, -(W / 2 + 0.05));
    c.add(tower);
    this.device(tower, 'HL001', 'HL-001', new THREE.Vector3(0, 0.39, 0));

    // Operator station with E-stop on the infeed end
    const station = new THREE.Group();
    const cabinet = box(0.1, 0.12, 0.05, mat(0xd6d9dc, 0.6, 0.1));
    const collar = cylZ(0.02, 0.006, M.safety);
    collar.position.set(0, 0.02, 0.028);
    const yellowPlate = box(0.06, 0.06, 0.002, M.safety);
    yellowPlate.position.set(0, 0.02, 0.026);
    const mushroom = new THREE.Group();
    const stem = cylZ(0.009, 0.014, M.mushroom);
    stem.position.z = 0.007;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.018, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), M.mushroom);
    head.rotation.x = Math.PI / 2;
    head.position.z = 0.012;
    mushroom.add(stem, head);
    mushroom.position.set(0, 0.02, 0.029);
    const start = cylZ(0.008, 0.008, mat(0x2e7d32, 0.4));
    start.position.set(-0.025, -0.035, 0.028);
    const stop = cylZ(0.008, 0.008, M.black);
    stop.position.set(0.025, -0.035, 0.028);
    station.add(cabinet, yellowPlate, collar, mushroom, start, stop);
    station.position.set(0.07, Y - 0.12, W / 2 + 0.075);
    c.add(station);
    this.estopCap = mushroom;
    this.device(station, 'ES001', 'ES-001', new THREE.Vector3(0, 0.1, 0.03));
  }

  // ───────────────────────────── runtime ─────────────────────────────

  private setPusher(z: number): void {
    this.pusherPlate.position.z = z;
    const back = PUSHER.retractedZ - 0.02;
    const front = z - 0.004;
    this.pusherRod.scale.z = Math.max(0.001, front - back);
    this.pusherRod.position.z = (front + back) / 2;
  }

  private carton(kind: DefectKind | null, face: Face | null): THREE.Group {
    const g = new THREE.Group();
    const body = new THREE.Mesh(this.itemGeom, M.carton);
    body.castShadow = true;
    body.receiveShadow = true;
    const tape = new THREE.Mesh(new THREE.BoxGeometry(G.itemLength + 0.001, 0.001, 0.012), M.tape);
    tape.position.y = G.itemHeight / 2 + 0.0005;
    g.add(body, tape);
    if (!(kind === 'label' && face === 'top')) {
      const shipping = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.0012, 0.018), M.label);
      shipping.position.set(-0.012, G.itemHeight / 2 + 0.0008, 0.012);
      g.add(shipping);
    }
    if (kind && face) g.add(this.defectMark(kind, face));
    return g;
  }

  /** Wrong (red) label or blue ink stain on one carton face. */
  private defectMark(kind: DefectKind, face: Face): THREE.Object3D {
    const mark = new THREE.Group();
    if (kind === 'label') {
      mark.add(new THREE.Mesh(new THREE.PlaneGeometry(0.026, 0.02), M.defectLabel));
    } else {
      mark.add(new THREE.Mesh(new THREE.CircleGeometry(0.011, 20), M.ink));
      for (const [x, y, r] of [[0.012, 0.008, 0.003], [-0.01, -0.01, 0.0025]]) {
        const drop = new THREE.Mesh(new THREE.CircleGeometry(r, 10), M.ink);
        drop.position.set(x, y, 0);
        mark.add(drop);
      }
    }
    const hx = G.itemLength / 2 + 0.0008;
    const hy = G.itemHeight / 2 + 0.0008;
    const hz = G.itemWidth / 2 + 0.0008;
    switch (face) {
      case 'top':
        // above the packing tape and shipping label (their tops are ~1.4 mm above the face)
        mark.rotation.x = -Math.PI / 2;
        mark.position.set(0.008, hy + 0.0012, -0.004);
        break;
      case 'left':
        mark.rotation.y = Math.PI;
        mark.position.set(0.004, 0, -hz);
        break;
      case 'right':
        mark.position.set(-0.004, 0, hz);
        break;
      case 'front':
        mark.rotation.y = Math.PI / 2;
        mark.position.set(hx, 0, 0);
        break;
      case 'back':
        mark.rotation.y = -Math.PI / 2;
        mark.position.set(-hx, 0, 0);
        break;
    }
    return mark;
  }

  /** Draws a plant frame. `ageSec` > 0 extrapolates moving cartons between 25 Hz frames. */
  update(f: PlantFrame, ageSec: number, ghosts: GhostEstimate[]): void {
    const ext = Math.min(ageSec, 0.08);
    const dist = f.beltDistance + f.beltSpeed * ext;
    this.beltTex.offset.x = -((dist / TILE) % 1);
    const angle = f.rollerAngle + (f.beltSpeed / R) * ext;
    for (const r of this.rollers) r.rotation.z = -angle;

    const tags = f.tags;
    for (const id of SENSOR_IDS) {
      const on = Boolean(tags[`Sensors.${id}`]);
      this.sensorLed[id].emissiveIntensity = on ? 2.2 : 0;
      this.sensorBeam[id].opacity = on ? 0.06 : 0.35;
    }
    this.setPusher(f.pusherZ);
    this.valveLed.emissiveIntensity = tags['Actuators.YV301'] ? 2.5 : 0;
    this.lamps.red.emissiveIntensity = tags['Actuators.HL001_Red'] ? 2.4 : 0;
    this.lamps.amber.emissiveIntensity = tags['Actuators.HL001_Amber'] ? 2.0 : 0;
    this.lamps.green.emissiveIntensity = tags['Actuators.HL001_Green'] ? 2.0 : 0;
    this.estopCap.position.z = tags['Safety.ES001'] ? 0.021 : 0.029;

    // Winding temperature shown as a heat tint on the motor
    const heat = Math.min(1, Math.max(0, (Number(tags['Drive.MotorTemp']) - 50) / 40));
    this.motorMat.color.copy(MOTOR_COLD).lerp(MOTOR_HOT, heat);
    this.motorMat.emissiveIntensity = heat * 0.35;

    this.flash = Math.max(0, this.flash - 0.06);
    this.ringLight.emissiveIntensity = 0.2 + this.flash * 3;

    // Cartons (scene state of the machine)
    const seen = new Set<number>();
    for (const it of f.items) {
      seen.add(it.id);
      let mesh = this.items.get(it.id);
      if (!mesh) {
        mesh = this.carton(it.defectKind, it.defectFace);
        this.conveyor.add(mesh);
        this.items.set(it.id, mesh);
      }
      const x = it.phase === 'conveying' ? it.x + f.beltSpeed * ext : it.x;
      mesh.position.set(x, Y + G.itemHeight / 2 + it.y, it.z);
      mesh.rotation.z = it.phase === 'falling' && it.y < -0.01 ? Math.max(-0.6, it.y * 3) : 0;
    }
    for (const [id, mesh] of this.items) {
      if (!seen.has(id)) {
        this.conveyor.remove(mesh);
        this.items.delete(id);
      }
    }

    // Twin estimates
    const ghostSeen = new Set<number>();
    if (this.showTwin) {
      for (const tr of ghosts) {
        ghostSeen.add(tr.id);
        let g = this.ghosts.get(tr.id);
        if (!g) {
          g = new THREE.LineSegments(this.ghostGeom, this.ghostMat);
          g.layers.set(LAYER_OVERLAY);
          this.conveyor.add(g);
          this.ghosts.set(tr.id, g);
        }
        g.material = tr.overdue ? this.ghostOverdueMat : this.ghostMat;
        g.position.set(tr.x, Y + G.itemHeight / 2, 0);
      }
    }
    for (const [id, g] of this.ghosts) {
      if (!ghostSeen.has(id)) {
        this.conveyor.remove(g);
        this.ghosts.delete(id);
      }
    }
  }

  /** Highlights belt zones 1–3 (index = zone number) with a pulsing overlay. */
  setJamZones(jam: boolean[]): void {
    for (let k = 1; k <= 3; k++) this.zones[k].visible = Boolean(jam[k]);
  }

  setTagValues(values: TagValues): void {
    for (const [id, v] of Object.entries(values) as [DeviceId, { text: string; abn?: boolean }][]) {
      const tag = this.tags.get(id);
      if (!tag) continue;
      if (tag.value.textContent !== v.text) tag.value.textContent = v.text;
      tag.root.classList.toggle('abn', !!v.abn);
    }
  }

  /** Screen position (host pixels) of a device's tag anchor, or null when behind the camera. */
  projectDevice(id: DeviceId): { x: number; y: number } | null {
    const tag = this.tags.get(id);
    if (!tag) return null;
    tag.anchor.getWorldPosition(this.tmp).project(this.camera);
    if (this.tmp.z > 1) return null;
    return {
      x: ((this.tmp.x + 1) / 2) * this.host.clientWidth,
      y: ((1 - this.tmp.y) / 2) * this.host.clientHeight,
    };
  }

  /**
   * Renders every tunnel camera off-screen and returns linear RGBA pixels (bottom-up rows).
   * A failed camera delivers a black frame.
   */
  captureInspection(failed: string): { id: CameraId; pixels: Uint8Array }[] {
    const r = this.renderer;
    const rt = this.inspectionTarget;
    const { w, h } = this.inspectionSize;
    const n = this.inspectionCams.length;
    const prev = r.getRenderTarget();
    this.scene.updateMatrixWorld();
    rt.scissorTest = true;
    this.inspectionCams.forEach(({ id, cam }, i) => {
      rt.viewport.set(i * w, 0, w, h);
      rt.scissor.set(i * w, 0, w, h);
      r.setRenderTarget(rt); // re-applies the target's viewport and scissor
      if (id === failed) {
        r.setClearColor(0x000000, 1);
        r.clear();
      } else {
        r.render(this.scene, cam);
      }
    });
    rt.scissorTest = false;
    rt.viewport.set(0, 0, n * w, h);
    const all = new Uint8Array(n * w * h * 4);
    r.readRenderTargetPixels(rt, 0, 0, n * w, h, all);
    r.setRenderTarget(prev);
    this.flash = 1;

    const row = w * 4;
    return this.inspectionCams.map(({ id }, i) => {
      const pixels = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) pixels.set(all.subarray(y * n * row + i * row, y * n * row + (i + 1) * row), y * row);
      return { id, pixels };
    });
  }

  render(): void {
    const now = performance.now();
    const dt = (now - this.lastRender) / 1000;
    this.lastRender = now;
    if (this.tween) {
      const tw = this.tween;
      tw.t = Math.min(1, tw.t + dt / 0.8);
      const e = tw.t < 0.5 ? 2 * tw.t * tw.t : 1 - Math.pow(-2 * tw.t + 2, 2) / 2;
      this.camera.position.lerpVectors(tw.from, tw.to, e);
      this.controls.target.lerpVectors(tw.tFrom, tw.tTo, e);
      if (tw.t >= 1) this.tween = null;
    }
    const pulse = 0.2 + 0.18 * (0.5 + 0.5 * Math.sin(now / 160));
    for (let k = 1; k <= 3; k++) this.zoneMats[k].opacity = pulse;
    this.controls.update();
    if (this.selection.visible) this.selection.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }

  setView(v: ViewName): void {
    const cx = CAM_X - L / 2;
    const views: Record<ViewName, [THREE.Vector3, THREE.Vector3]> = {
      iso: [new THREE.Vector3(1.15, 1.45, 1.35), new THREE.Vector3(0, 0.72, 0)],
      side: [new THREE.Vector3(0, 0.98, 1.75), new THREE.Vector3(0, 0.74, 0)],
      top: [new THREE.Vector3(0, 2.35, 0.02), new THREE.Vector3(0, 0.78, 0)],
      inspect: [new THREE.Vector3(cx + 0.3, Y + 0.36, 0.52), new THREE.Vector3(cx - 0.02, Y + 0.06, 0)],
    };
    const [to, tTo] = views[v];
    this.tween = { from: this.camera.position.clone(), to, tFrom: this.controls.target.clone(), tTo, t: 0 };
  }

  setLabels(on: boolean): void {
    for (const l of this.labelObjects) l.visible = on;
  }

  setTwinOverlay(on: boolean): void {
    this.showTwin = on;
    for (const id of SENSOR_IDS) this.sensorBeam[id].visible = on;
  }

  setTheme(t: SceneTheme): void {
    (this.scene.background as THREE.Color).set(t.background);
    this.floorMat.color.set(t.floor);
    this.scene.remove(this.grid);
    this.grid.dispose();
    this.grid = new THREE.GridHelper(10, 40, t.grid1, t.grid2);
    this.grid.position.y = 0.001;
    this.scene.add(this.grid);
  }

  select(id: DeviceId | null): void {
    const obj = id ? this.pickables.find((o) => o.userData.device === id) : undefined;
    this.selection.visible = !!obj;
    if (obj) this.selection.setFromObject(obj);
    for (const [tid, tag] of this.tags) tag.root.classList.toggle('selected', tid === id);
  }

  private bindPicking(): void {
    const el = this.renderer.domElement;
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let down: { x: number; y: number } | null = null;

    const hit = (e: PointerEvent): DeviceId | null => {
      const rect = el.getBoundingClientRect();
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      this.scene.updateMatrixWorld(); // don't rely on a render having happened since the last change
      this.camera.updateMatrixWorld();
      ray.setFromCamera(ndc, this.camera);
      for (const h of ray.intersectObjects(this.pickables, true)) {
        let o: THREE.Object3D | null = h.object;
        while (o && !o.userData.device) o = o.parent;
        if (o) return o.userData.device as DeviceId;
      }
      return null;
    };

    el.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    el.addEventListener('pointerup', (e) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) this.onPick(hit(e));
      down = null;
    });
    el.addEventListener('pointermove', (e) => {
      if (e.buttons) return;
      el.style.cursor = hit(e) ? 'pointer' : 'grab';
    });
  }

  private resize(): void {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
