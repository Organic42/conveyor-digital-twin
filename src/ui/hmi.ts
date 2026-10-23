/**
 * HMI application: owns the plant link and the twin services, and renders the operator screens.
 */
import { PlantLink } from '../bus/link';
import type { PlantFrame } from '../bus/protocol';
import { NAMESPACE, TAG_DEFS, formatTag, nodeId } from '../bus/tags';
import { PackML, TRANSITIONS } from '../plant/model';
import { CAMERAS, MOTOR, SENSOR_IDS, SENSOR_LABEL, THERMAL } from '../plant/params';
import { TwinScene, type GhostEstimate, type TagValues, type ViewName } from '../scene/scene';
import { AlarmManager, type AlarmDef, type Priority } from '../twin/alarms';
import { AnomalyDetector } from '../twin/anomaly';
import { CONTROL_POWER_W, EnergyMeter, GRID_KG_CO2_PER_KWH } from '../twin/energy';
import { FeatureExtractor } from '../twin/features';
import { Historian } from '../twin/historian';
import { Maintenance, type WorkOrder } from '../twin/maintenance';
import { OeeTracker } from '../twin/oee';
import { Recorder } from '../twin/recorder';
import { RulEstimator, type RulEstimate } from '../twin/rul';
import { VibrationAnalyzer, ZONE_D } from '../twin/vibration';
import { ShadowModel } from '../twin/shadow';
import { ControlChart, RULE_TEXT } from '../twin/spc';
import { ALARMS, Supervisor, fmtDuration } from '../twin/supervisor';
import { runScenario, type Scenario, type ScenarioResult } from '../twin/whatif';
import { BenchmarkView, OptimiserView } from './analysisViews';
import { FaceplatePopover } from './faceplate';
import { LineOverview } from './overview';
import { PdmView } from './pdmView';
import { AnomalyPanel } from './predictive';
import { VisionStation } from './visionStation';
import { applyTheme, cssVar, loadTheme, type Theme } from './theme';
import { TrendChart, type Series } from './trends';
import { $, AnalogIndicator, bindTabs, download, escapeHtml, hhmmss, pct, toast } from './widgets';

const HIST_KEYS = ['sp', 'v', 'vEst', 'i', 'iModel', 'temp', 'slip', 'ires', 'power'] as const;
type HistKey = (typeof HIST_KEYS)[number];

const ABNORMAL_STATES = new Set<number>([PackML.Aborted, PackML.Aborting, PackML.Held, PackML.Holding]);
const PRIORITY_SHAPE: Record<Priority, string> = { 1: 'sq', 2: 'tri', 3: 'dia' };
const STATE_COLOR: Record<string, string> = {
  EXECUTE: '#5e6872',
  HELD: '#d08a1e',
  HOLDING: '#d08a1e',
  UNHOLDING: '#d08a1e',
  ABORTED: '#c0392b',
  ABORTING: '#c0392b',
  CLEARING: '#9aa1a8',
  STARTING: '#7f8c96',
  STOPPING: '#9aa1a8',
  RESETTING: '#9aa1a8',
};
const ALARM_TABS = new Set(['active', 'journal', 'tags']);

const SPC_ALARMS = {
  drive: { id: 'SPC.DRIVE', tag: 'SPC.DriveCurrent', text: 'Drive current deviation out of statistical control', priority: 3 },
  quality: { id: 'SPC.QUALITY', tag: 'SPC.RejectRate', text: 'Reject rate out of statistical control', priority: 3 },
} satisfies Record<string, AlarmDef>;

const ANOMALY_ALARM: AlarmDef = {
  id: 'TWIN.ANOMALY',
  tag: 'Twin.LearnedModel',
  text: 'Learned model: behaviour outside the normal envelope',
  priority: 2,
};

/** Rule-based alarms that "explain" a learned-model anomaly. */
const isRuleDiagnosis = (id: string) =>
  id === 'BELT.SLIP' || id === 'M001.LOAD' || id.startsWith('JAM.') || (id.startsWith('PE') && id.endsWith('.FAULT')) || id === 'VISION.NOREAD';

export class Hmi {
  private readonly link = new PlantLink();
  private readonly shadow = new ShadowModel();
  private readonly alarms = new AlarmManager();
  private readonly supervisor = new Supervisor(this.link, this.alarms, this.shadow);
  private readonly oee = new OeeTracker();
  private readonly energy = new EnergyMeter();
  private readonly hist = new Historian<HistKey>(HIST_KEYS);
  private readonly recorder = new Recorder();
  private readonly maintenance = new Maintenance();
  private readonly spcDrive = new ControlChart('I', 20);
  private readonly spcQual = new ControlChart('p', 5, 10);
  private readonly features = new FeatureExtractor();
  private readonly anomaly = new AnomalyDetector();
  private readonly vibration = new VibrationAnalyzer();
  /** Bearing RUL: overall vibration velocity rising towards ISO 10816 zone D. */
  private readonly rul = new RulEstimator({ threshold: ZONE_D, rising: true, minDelta: 0.3, minSlopePerS: 0.1 / 60 });
  private rulEst: RulEstimate | null = null;
  private readonly scene: TwinScene;
  private readonly overview: LineOverview;
  private readonly faceplate: FaceplatePopover;
  private readonly visionStation: VisionStation;
  private readonly anomalyPanel: AnomalyPanel;
  private readonly pdm: PdmView;
  private readonly optimiserView: OptimiserView;

  private readonly ind: Record<'speed' | 'current' | 'temp' | 'power', AnalogIndicator>;
  private readonly trends: { drive: TrendChart; motor: TrendChart; twin: TrendChart };
  private readonly energyChart: TrendChart;
  private readonly spcCharts: { drive: TrendChart; qual: TrendChart };
  private wiChart: TrendChart | null = null;

  private theme: Theme = loadTheme();
  private trendRange = 120;
  private lastSample = 0;
  private alarmVersion = -1;
  private woVersion = -1;
  private journalVisible = false;
  private showTwin = true;

  private lastRequest = 0;
  private driveAcc = { sum: 0, n: 0, start: 0 };
  private qualAcc = { defects: 0, n: 0 };
  private pusherPrev = false;

  /** Replay position is baseTs advanced by wall-clock time while playing. */
  private replay = { active: false, baseTs: 0, baseWall: 0, playing: false, speed: 1, dragging: false };

  private readonly tagCells = new Map<string, HTMLElement>();
  private whatIfResult: { base: ScenarioResult; prop: ScenarioResult } | null = null;

  constructor() {
    applyTheme(this.theme);
    this.scene = new TwinScene($('three'));
    this.scene.onPick = (id) => this.select(id);
    this.overview = new LineOverview($<HTMLCanvasElement>('overview'));
    this.visionStation = new VisionStation(this.scene, (cam, on) =>
      this.alarms.log('TWIN', 'Vision', `${CAMERAS.find((c) => c.id === cam)!.label} ${on ? 'included in' : 'excluded from'} the decision`),
    );
    this.faceplate = new FaceplatePopover(
      {
        tag: (p) => this.viewFrame()?.tags[p],
        shadow: this.shadow,
        vision: this.visionStation.stats,
        camerasEnabled: this.visionStation.enabled,
        maintenance: this.maintenance,
        raiseWorkOrder: (asset) => this.raiseManualOrder(asset),
      },
      () => this.select(null),
    );
    this.anomalyPanel = new AnomalyPanel(this.anomaly, () => {
      this.anomaly.retrain();
      this.alarms.log('TWIN', 'Learned model', 'Re-learning normal behaviour');
    });
    this.pdm = new PdmView(this.vibration, this.rul);
    this.optimiserView = new OptimiserView(
      () => this.scenarioBase(),
      () => Number(this.link.tag('Drive.SpeedSetpoint') ?? 0.3),
      (v) => this.applySpeed(v),
    );
    new BenchmarkView((rep) => {
      const wear = rep.rows.find((r) => r.fault === 'wear');
      if (wear) this.pdm.setDetectionRate(wear.ruleDetected / wear.runs);
    });

    const drive = $('driveIndicators');
    this.ind = {
      speed: new AnalogIndicator(drive, { label: 'Belt speed (ENC-001)', unit: 'm/s', min: 0, max: 0.5, normal: [0.1, 0.45], decimals: 3 }),
      current: new AnalogIndicator(drive, { label: 'Motor current', unit: 'A', min: 0, max: 3, normal: [0, 2.0], hi: 2.0, hihi: MOTOR.ratedCurrent, decimals: 2 }),
      temp: new AnalogIndicator(drive, { label: 'Winding temperature', unit: '°C', min: 20, max: 100, normal: [20, 75], hi: THERMAL.highAlarm, hihi: THERMAL.trip, decimals: 1 }),
      power: new AnalogIndicator(drive, { label: 'Electrical power', unit: 'W', min: 0, max: 80, normal: [0, 55], hi: 60, hihi: 70, decimals: 1 }),
    };

    this.trends = {
      drive: new TrendChart($('trendDrive'), 'Belt speed', [
        { label: 'Ramp SP', color: '--pen-ref', dash: [5, 4], decimals: 3 },
        { label: 'Encoder', color: '--pen-1', decimals: 3 },
        { label: 'Twin est.', color: '--pen-2', decimals: 3 },
      ], [{ scale: 'v', label: 'm/s', range: [0, 0.5] }]),
      motor: new TrendChart($('trendMotor'), 'Motor M-001', [
        { label: 'Current', color: '--pen-3', scale: 'A' },
        { label: 'Model', color: '--pen-3b', scale: 'A', dash: [5, 4] },
        { label: 'Temp', color: '--pen-4', scale: 'C', decimals: 1 },
      ], [{ scale: 'A', label: 'A', range: [0, 3] }, { scale: 'C', label: '°C', side: 'right', range: [20, 100] }]),
      twin: new TrendChart($('trendTwin'), 'Twin residuals', [
        { label: 'Slip', color: '--pen-1', scale: 'pct', decimals: 1 },
        { label: 'ΔI', color: '--pen-3', scale: 'dA' },
      ], [{ scale: 'pct', label: 'slip %', range: [-5, 40] }, { scale: 'dA', label: 'ΔI A', side: 'right', range: [-0.5, 1.5] }]),
    };
    this.energyChart = new TrendChart($('energyChart'), 'Electrical power', [
      { label: 'Total', color: '--pen-4', decimals: 1 },
    ], [{ scale: 'W', label: 'W', range: [0, 80] }]);
    const spcPens = (decimals: number) => [
      { label: 'Value', color: '--pen-1', markers: true, decimals },
      { label: 'CL', color: '--pen-ref', dash: [5, 4], width: 1, decimals },
      { label: 'UCL', color: '--pen-limit', dash: [3, 3], width: 1, decimals },
      { label: 'LCL', color: '--pen-limit', dash: [3, 3], width: 1, decimals },
      { label: 'Signal', color: '--p2', pointsOnly: true, decimals },
    ];
    this.spcCharts = {
      drive: new TrendChart($('spcDriveChart'), '', spcPens(3), [{ scale: 'y', label: 'ΔI A' }], false),
      qual: new TrendChart($('spcQualChart'), '', spcPens(2), [{ scale: 'y', label: 'p' }], false),
    };

    this.scene.setTheme(this.sceneColors());
    this.bindControls();
    this.bindReplay();
    this.buildTagTable();
    this.link.onFrame((f) => this.onFrame(f));
    this.alarms.log('EVENT', 'HMI', 'Twin started — subscribed to plant process image');
    requestAnimationFrame(() => this.loop());
    this.startTimers();
  }

  // ───────────────────────────── data path ─────────────────────────────

  private onFrame(f: PlantFrame): void {
    const t = f.tags;
    this.shadow.update(f);
    this.supervisor.evaluate(f);
    this.oee.update(t, f.ts);
    this.energy.update(t, f.ts);
    this.recorder.record(f, this.shadow.tracks, this.supervisor.jamZones, this.shadow.sensorSuspect);

    const pusher = Boolean(t['Actuators.YV301']);
    if (pusher && !this.pusherPrev) this.maintenance.pusherCycles++;
    this.pusherPrev = pusher;

    // SPC: mean current deviation from the motor model over 2 s windows at steady speed
    const steady = t['Status.State'] === PackML.Execute && Math.abs(Number(t['Drive.SpeedActual']) - Number(t['Drive.SpeedSetpoint'])) < 0.01;
    if (steady) {
      this.driveAcc.sum += Number(t['Drive.MotorCurrent']) - this.shadow.currentModel;
      this.driveAcc.n++;
    }
    if (f.ts - this.driveAcc.start >= 2000) {
      if (this.driveAcc.n >= 40) this.spcDrive.add(f.ts, this.driveAcc.sum / this.driveAcc.n);
      this.driveAcc = { sum: 0, n: 0, start: f.ts };
    }

    // Condition monitoring (VT-001), prognostics and the learned (data-driven) anomaly model
    if (f.vibration) {
      this.vibration.update(f.ts, f.vibration);
      this.rul.update(f.ts, this.vibration.vRms, steady);
    }
    const x = this.features.update(f, this.shadow);
    if (x) {
      const r = this.anomaly.add(f.ts, x, Number(t['Drive.SpeedSetpoint']));
      const top = r?.contributions[0];
      this.alarms.set(ANOMALY_ALARM, this.anomaly.status === 'ANOMALY', top ? `${top.name} ${(top.share * 100).toFixed(0)} %` : '');
    }

    if (f.ts - this.lastSample >= 200) {
      this.lastSample = f.ts;
      this.hist.sample(f.ts, {
        sp: Number(t['Drive.SpeedRamp']),
        v: Number(t['Drive.SpeedActual']),
        vEst: this.shadow.beltSpeedEst,
        i: Number(t['Drive.MotorCurrent']),
        iModel: this.shadow.currentModel,
        temp: Number(t['Drive.MotorTemp']),
        slip: this.shadow.slip * 100,
        ires: this.shadow.currentResidual,
        power: this.energy.powerW,
      });
    }

    // Hardware trigger: capture on the frame that carries the PE-201 request, independent of the
    // render loop (which the browser throttles when the page is not visible).
    const req = Number(t['Inspection.RequestId']);
    if (req > 0 && req !== this.lastRequest) {
      this.lastRequest = req;
      this.scene.update(f, 0, this.shadow.tracks);
      this.runInspection(req, String(t['Simulation.CameraFail']));
    }
  }

  /** Frame currently shown in the 3D view: the live one, or the replayed one. */
  private viewFrame(): PlantFrame | null {
    if (this.replay.active) return this.recorder.at(this.replayTs())?.frame ?? null;
    return this.link.frame;
  }

  /** 3D rendering and the overview; panel refresh runs on timers so it never depends on the frame rate. */
  private loop(): void {
    const now = performance.now();
    let view: { frame: PlantFrame; ghosts: GhostEstimate[]; jam: boolean[]; suspect: boolean[] } | null = null;
    if (this.replay.active) {
      const snap = this.recorder.at(this.replayTs());
      if (snap) {
        this.scene.update(snap.frame, 0, snap.ghosts);
        view = { frame: snap.frame, ghosts: snap.ghosts, jam: snap.jamZones, suspect: snap.sensorSuspect };
      }
    }
    if (!view && this.link.frame) {
      const f = this.link.frame;
      this.scene.update(f, (now - this.link.receivedAt) / 1000, this.shadow.tracks);
      view = { frame: f, ghosts: this.shadow.tracks, jam: this.supervisor.jamZones, suspect: this.shadow.sensorSuspect };
    }
    if (view) {
      this.scene.setJamZones(view.jam);
      this.overview.draw(view.frame, view.ghosts, view.jam, view.suspect, this.showTwin);
    }
    this.scene.render();
    if (this.faceplate.selected) {
      const host = $('three');
      this.faceplate.position(this.scene.projectDevice(this.faceplate.selected), host.clientWidth, host.clientHeight);
    }
    requestAnimationFrame(() => this.loop());
  }

  private startTimers(): void {
    setInterval(() => {
      if (this.link.frame) this.updatePanels(this.link.frame);
      this.updateViewTags();
      this.faceplate.update();
      this.updateReplayUi();
    }, 100);
    setInterval(() => {
      this.updateTrends();
      this.updateSpc();
      this.renderSlow();
    }, 500);
    setInterval(() => {
      this.supervisor.checkLink();
      this.evaluateMaintenance();
      this.renderMaintenance(true);
      this.renderReplayMarkers();
      $('clock').textContent = new Date().toLocaleTimeString('en-GB');
    }, 1000);
  }

  private runInspection(tid: number, failedCamera: string): void {
    const r = this.visionStation.inspect(failedCamera);
    void this.link.call('ReportInspection', tid, r.verdict);

    const noRead = r.verdict === 'NO_READ';
    this.supervisor.visionNoReads = noRead ? this.supervisor.visionNoReads + 1 : 0;
    this.supervisor.visionNoReadCamera = noRead && r.cause ? CAMERAS.find((c) => c.id === r.cause!.camera)!.label : '';

    // p-chart subgroup (no-reads carry no quality information)
    if (!noRead) {
      this.qualAcc.n++;
      if (r.verdict === 'DEFECT') this.qualAcc.defects++;
      if (this.qualAcc.n === this.spcQual.subgroupSize) {
        this.spcQual.add(Date.now(), this.qualAcc.defects / this.qualAcc.n);
        this.qualAcc = { defects: 0, n: 0 };
      }
    }
  }

  // ───────────────────────────── commands & controls ─────────────────────────────

  private async command(method: string, ...args: unknown[]): Promise<void> {
    const r = await this.link.call(method, ...args);
    const call = `${method}(${args.map((a) => JSON.stringify(a)).join(', ')})`;
    this.alarms.log('CMD', 'Operator', `${call} → ${r.status}${r.message ? `: ${r.message}` : ''}`);
    if (r.status !== 'Good') toast(`${method} rejected — ${r.message ?? r.status}`, 'bad');
  }

  private bindControls(): void {
    document.querySelectorAll<HTMLButtonElement>('[data-cmd]').forEach((b) =>
      b.addEventListener('click', () => void this.command(b.dataset.cmd!)),
    );

    const range = $<HTMLInputElement>('spRange');
    const input = $<HTMLInputElement>('spInput');
    range.addEventListener('input', () => (input.value = Number(range.value).toFixed(2)));
    input.addEventListener('input', () => (range.value = input.value));
    const write = () => void this.command('SetSpeed', Number(input.value));
    $('spWrite').addEventListener('click', write);
    input.addEventListener('keydown', (e) => e.key === 'Enter' && write());

    $<HTMLInputElement>('autoProtect').addEventListener('change', (e) => {
      this.supervisor.autoProtect = (e.target as HTMLInputElement).checked;
      this.alarms.log('TWIN', 'Auto-protect', this.supervisor.autoProtect ? 'Enabled' : 'Disabled');
    });

    // Header
    $('btnTheme').addEventListener('click', () => this.setTheme(this.theme === 'dark' ? 'light' : 'dark'));
    const drawer = $('simDrawer');
    const setDrawer = (open: boolean) => {
      drawer.hidden = !open;
      $('btnSim').classList.toggle('on', open);
    };
    $('btnSim').addEventListener('click', () => setDrawer(drawer.hidden));
    $('simClose').addEventListener('click', () => setDrawer(false));

    // 3D view
    document.querySelectorAll<HTMLButtonElement>('#viewSeg [data-view]').forEach((b) =>
      b.addEventListener('click', () => {
        document.querySelectorAll('#viewSeg button').forEach((x) => x.classList.toggle('on', x === b));
        this.scene.setView(b.dataset.view as ViewName);
      }),
    );
    const toggle = (id: string, fn: (on: boolean) => void) => {
      const b = $(id);
      b.addEventListener('click', () => fn(b.classList.toggle('on')));
    };
    toggle('tglLabels', (on) => this.scene.setLabels(on));
    toggle('tglTwin', (on) => {
      this.showTwin = on;
      this.scene.setTwinOverlay(on);
    });

    bindTabs((tab) => {
      if (ALARM_TABS.has(tab)) this.journalVisible = tab === 'journal';
      this.alarmVersion = -1;
      this.refreshVisible();
    });

    // Trends
    document.querySelectorAll<HTMLButtonElement>('#trendRange [data-range]').forEach((b) =>
      b.addEventListener('click', () => {
        document.querySelectorAll('#trendRange button').forEach((x) => x.classList.toggle('on', x === b));
        this.trendRange = Number(b.dataset.range);
        this.updateTrends();
      }),
    );

    // Alarms (table and banner)
    $('ackAll').addEventListener('click', () => this.alarms.ackAll());
    for (const id of ['alarmBody', 'alarmBanner']) {
      $(id).addEventListener('click', (e) => {
        const ack = (e.target as HTMLElement).closest<HTMLElement>('[data-ack]')?.dataset.ack;
        if (ack) this.alarms.ack(ack);
      });
    }

    // Production
    $('btnNewShift').addEventListener('click', () => {
      this.oee.newShift();
      this.energy.newShift(this.link.frame?.tags ?? {});
      this.alarms.log('EVENT', 'OEE', `Shift ${this.oee.shiftNo} started`);
    });
    $('btnReport').addEventListener('click', () => this.exportReport());

    // SPC
    $('spcRebase').addEventListener('click', () => {
      this.spcDrive.rebaseline();
      this.spcQual.rebaseline();
      this.alarms.log('TWIN', 'SPC', 'Control limits re-baselined');
    });

    // What-if
    const wiSpeed = $<HTMLInputElement>('wiSpeed');
    wiSpeed.addEventListener('input', () => ($('wiSpeedVal').textContent = `${Number(wiSpeed.value).toFixed(2)} m/s`));
    $('wiRun').addEventListener('click', () => this.runWhatIf());
    $('wiApply').addEventListener('click', () => this.whatIfResult && this.applySpeed(this.whatIfResult.prop.speed));

    // Maintenance
    $('woList').addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-wo-act]');
      if (el) this.workOrderAction(el.dataset.woId!, el.dataset.woAct as 'start' | 'done');
    });

    // Fault injection (virtual plant)
    const slider = (id: string, fault: string, scale: number, fmt: (v: number) => string) => {
      const el = $<HTMLInputElement>(id);
      const out = $(`${id}Val`);
      el.addEventListener('input', () => (out.textContent = fmt(Number(el.value))));
      el.addEventListener('change', () => {
        void this.link.call('SetFault', fault, Number(el.value) / scale);
        this.alarms.log('EVENT', 'Simulation', `Fault ${fault} = ${fmt(Number(el.value))}`);
      });
    };
    slider('fSlip', 'slip', 100, (v) => `${v} %`);
    slider('fWear', 'bearingWear', 100, (v) => `${v} %`);
    slider('fWearRate', 'wearRate', 6000, (v) => `${v} %/min`);
    slider('fDefect', 'defectRate', 100, (v) => `${v} %`);
    $<HTMLSelectElement>('fSensor').addEventListener('change', (e) => {
      const v = (e.target as HTMLSelectElement).value;
      void this.link.call('SetFault', 'sensorFail', v);
      this.alarms.log('EVENT', 'Simulation', `Photo-eye failure = ${v}`);
    });
    $('fJam').addEventListener('click', () => {
      const on = !this.link.tag('Simulation.Jam');
      void this.link.call('SetFault', 'jam', on);
      this.alarms.log('EVENT', 'Simulation', on ? 'Obstruction placed in zone 2' : 'Obstruction removed from zone 2');
    });
    $<HTMLSelectElement>('fCam').addEventListener('change', (e) => {
      const v = (e.target as HTMLSelectElement).value;
      void this.link.call('SetFault', 'cameraFail', v);
      this.alarms.log('EVENT', 'Simulation', v === 'NONE' ? 'All cameras restored' : `${v} failed (black image)`);
    });
    $('fRub').addEventListener('click', () => {
      const on = !this.link.tag('Simulation.GuideRub');
      void this.link.call('SetFault', 'guideRub', on);
      this.alarms.log('EVENT', 'Simulation', on ? 'Zone-3 side guide misaligned (unmodelled fault)' : 'Zone-3 side guide realigned');
    });
    $('fEstop').addEventListener('click', () => void this.link.call('SetEStop', !this.link.tag('Safety.ES001')));
    $('fReset').addEventListener('click', () => {
      const all = [
        ['slip', 0],
        ['bearingWear', 0],
        ['wearRate', 0],
        ['defectRate', 0.12],
        ['sensorFail', 'NONE'],
        ['jam', false],
        ['cameraFail', 'NONE'],
        ['guideRub', false],
      ] as const;
      for (const [k, v] of all) {
        void this.link.call('SetFault', k, v);
        this.syncSimControl(k, v);
      }
      void this.link.call('SetEStop', false);
      this.alarms.log('EVENT', 'Simulation', 'All injected faults cleared');
    });

    $('tagFilter').addEventListener('input', (e) => {
      const q = (e.target as HTMLInputElement).value.toLowerCase();
      document.querySelectorAll<HTMLTableRowElement>('#tagTable tr[data-path]').forEach((tr) => {
        tr.hidden = !!q && !tr.dataset.path!.toLowerCase().includes(q);
      });
    });
  }

  /** Mirrors a fault value back into the simulation drawer controls. */
  private syncSimControl(fault: string, value: unknown): void {
    const map: Record<string, [string, number, string]> = {
      slip: ['fSlip', 100, '%'],
      bearingWear: ['fWear', 100, '%'],
      wearRate: ['fWearRate', 6000, '%/min'],
      defectRate: ['fDefect', 100, '%'],
    };
    if (map[fault]) {
      const [id, scale, unit] = map[fault];
      const v = Math.round(Number(value) * scale);
      $<HTMLInputElement>(id).value = String(v);
      $(`${id}Val`).textContent = `${v} ${unit}`;
    } else if (fault === 'sensorFail') {
      $<HTMLSelectElement>('fSensor').value = String(value);
    } else if (fault === 'cameraFail') {
      $<HTMLSelectElement>('fCam').value = String(value);
    }
  }

  private setTheme(t: Theme): void {
    this.theme = t;
    applyTheme(t);
    this.scene.setTheme(this.sceneColors());
    this.overview.refreshTheme();
    for (const c of [...Object.values(this.trends), this.energyChart, ...Object.values(this.spcCharts), this.wiChart]) c?.refreshTheme();
    this.anomalyPanel.refreshTheme();
    this.pdm.refreshTheme();
    this.optimiserView.refreshTheme();
    this.updateTrends();
    this.updateSpc();
  }

  private sceneColors() {
    return {
      background: cssVar('--scene-bg'),
      floor: cssVar('--scene-floor'),
      grid1: cssVar('--scene-grid1'),
      grid2: cssVar('--scene-grid2'),
    };
  }

  private select(id: Parameters<TwinScene['select']>[0]): void {
    this.scene.select(id);
    this.faceplate.show(id);
  }

  // ───────────────────────────── replay ─────────────────────────────

  private bindReplay(): void {
    const slider = $<HTMLInputElement>('rpSlider');
    const tsAt = (v: number) => this.recorder.start + (v / 1000) * (this.recorder.end - this.recorder.start);
    slider.addEventListener('pointerdown', () => (this.replay.dragging = true));
    slider.addEventListener('pointerup', () => (this.replay.dragging = false));
    slider.addEventListener('input', () => {
      const v = Number(slider.value);
      if (v >= 999) this.goLive();
      else this.enterReplay(tsAt(v), false);
    });
    $('rpLive').addEventListener('click', () => this.goLive());
    $('replayBadgeLive').addEventListener('click', () => this.goLive());
    $('rpBack').addEventListener('click', () => {
      const from = this.replay.active ? this.replayTs() : this.recorder.end;
      this.enterReplay(from - 10_000, this.replay.active ? this.replay.playing : true);
    });
    $('rpPlay').addEventListener('click', () => {
      if (!this.replay.active) this.enterReplay(this.recorder.end - 30_000, true);
      else this.enterReplay(this.replayTs(), !this.replay.playing);
    });
    $<HTMLSelectElement>('rpSpeed').addEventListener('change', (e) => {
      const ts = this.replayTs();
      this.replay.speed = Number((e.target as HTMLSelectElement).value);
      if (this.replay.active) this.enterReplay(ts, this.replay.playing);
    });
    $('rpMarkers').addEventListener('click', (e) => {
      const ts = Number((e.target as HTMLElement).closest<HTMLElement>('[data-ts]')?.dataset.ts);
      if (ts) this.enterReplay(ts - 3000, true);
    });
  }

  private replayTs(): number {
    const r = this.replay;
    return r.playing ? r.baseTs + (performance.now() - r.baseWall) * r.speed : r.baseTs;
  }

  private enterReplay(ts: number, playing: boolean): void {
    if (this.recorder.snapshots.length < 2) return;
    this.replay.active = true;
    this.replay.baseTs = Math.min(this.recorder.end, Math.max(this.recorder.start, ts));
    this.replay.baseWall = performance.now();
    this.replay.playing = playing;
    $('viewport').classList.add('replaying');
    $('replayBadge').hidden = false;
    $('rpLive').classList.remove('on');
  }

  private goLive(): void {
    this.replay.active = false;
    this.replay.playing = false;
    $('viewport').classList.remove('replaying');
    $('replayBadge').hidden = true;
    $('rpLive').classList.add('on');
  }

  private updateReplayUi(): void {
    const r = this.replay;
    if (r.active && r.playing && this.replayTs() >= this.recorder.end) this.goLive();
    const ts = this.replayTs();
    const span = Math.max(1, this.recorder.end - this.recorder.start);
    if (!r.dragging) {
      $<HTMLInputElement>('rpSlider').value = String(r.active ? Math.round(((ts - this.recorder.start) / span) * 1000) : 1000);
    }
    $('rpPlay').textContent = r.active && r.playing ? '❚❚' : '▶';
    if (r.active) {
      const behind = `−${fmtDuration((this.recorder.end - ts) / 1000)}`;
      $('rpTime').textContent = `${hhmmss(ts)} · ${behind}`;
      $('replayBadgeTime').textContent = `${hhmmss(ts)} (${behind})`;
    } else {
      $('rpTime').textContent = `live · ${fmtDuration(span / 1000)} buffered`;
    }
  }

  private renderReplayMarkers(): void {
    const start = this.recorder.start;
    const span = this.recorder.end - start;
    if (span <= 0) return;
    $('rpMarkers').innerHTML = this.alarms.journal
      .filter((j) => j.kind === 'ALARM' && j.ts >= start)
      .slice(0, 150)
      .map(
        (j) =>
          `<button class="rp-marker p${j.priority ?? 3}" style="left:${((j.ts - start) / span) * 100}%" data-ts="${j.ts}" title="${hhmmss(j.ts)} ${escapeHtml(j.text)} — click to replay"></button>`,
      )
      .join('');
  }

  // ───────────────────────────── panels ─────────────────────────────

  private updatePanels(f: PlantFrame): void {
    const t = f.tags;
    const state = Number(t['Status.State']);
    const stateName = String(t['Status.StateName']);

    // Header
    $('stateName').textContent =
      stateName + (state === PackML.Aborted && t['Status.AbortReason'] !== 'NONE' ? ` · ${t['Status.AbortReason']}` : '');
    $('stateChip').classList.toggle('abnormal', ABNORMAL_STATES.has(state));
    const o = this.oee.snapshot();
    $('kpiOee').textContent = o.planned > 0 ? pct(o.oee, 0) : '—';
    $('kpiRate').textContent = o.ratePerMin > 0 ? o.ratePerMin.toFixed(0) : '—';
    $('kpiGood').textContent = String(t['Counters.Outfeed']);
    $('kpiReject').textContent = String(t['Counters.Rejected']);
    $('kpiPower').textContent = `${this.energy.powerW.toFixed(0)} W`;
    const link = $('linkStatus');
    link.classList.toggle('bad', !this.link.connected);
    link.innerHTML = this.link.connected
      ? `<i></i>Plant link · ${this.link.rateHz} Hz · ${this.link.latencyMs.toFixed(0)} ms`
      : '<i></i>Plant link lost';

    // Commands enabled per PackML state model
    document.querySelectorAll<HTMLButtonElement>('[data-cmd]').forEach((b) => {
      b.disabled = !TRANSITIONS[b.dataset.cmd!].from.includes(state);
    });
    $('spCurrent').textContent = `active ${Number(t['Drive.SpeedSetpoint']).toFixed(2)} m/s`;

    // Drive
    this.ind.speed.set(Number(t['Drive.SpeedActual']), Number(t['Drive.SpeedSetpoint']));
    this.ind.current.set(Number(t['Drive.MotorCurrent']));
    this.ind.temp.set(Number(t['Drive.MotorTemp']));
    this.ind.power.set(this.energy.powerW);

    const total = Number(t['Counters.Outfeed']) + Number(t['Counters.Rejected']);
    $('counters').innerHTML = kv([
      ['Infeed PE-101', String(t['Counters.Infeed'])],
      ['Inspected CAM-201', String(t['Counters.Inspected'])],
      ['Outfeed PE-401', String(t['Counters.Outfeed'])],
      ['Rejected YV-301', String(t['Counters.Rejected'])],
      ['Tracking queue', String(t['Tracking.QueueLength'])],
      ['First-pass yield', total ? pct(Number(t['Counters.Outfeed']) / total) : '—'],
    ]);

    if (this.visible('twin')) this.renderHealth(f);
    if (this.visible('prod')) this.renderProduction(o);
    if (this.visible('tags')) for (const [path, cell] of this.tagCells) cell.textContent = formatTag(path, t[path]);
    if (!$('simDrawer').hidden) this.renderSimulation(t);
    this.updateAlarms();
  }

  /** True when a tab pane is on screen — hidden panes are not re-rendered. */
  private visible(pane: string): boolean {
    return document.querySelector(`.tab-pane.on[data-pane="${pane}"]`) !== null;
  }

  /** 2 Hz panels. The RUL estimate is always computed (maintenance needs it); drawing only when visible. */
  private renderSlow(): void {
    if (this.visible('twin')) this.anomalyPanel.render();
    this.rulEst = this.pdm.render(this.visible('pdm'));
    if (this.visible('vision')) this.visionStation.render();
  }

  /** Immediate refresh after a tab switch, so a pane never shows stale content. */
  private refreshVisible(): void {
    if (this.link.frame) this.updatePanels(this.link.frame);
    this.updateTrends();
    this.updateSpc();
    this.renderSlow();
    this.renderMaintenance(false);
  }

  private renderHealth(f: PlantFrame): void {
    const t = f.tags;
    const state = Number(t['Status.State']);
    const sh = this.shadow;
    $('mSlip').textContent = pct(Math.max(0, sh.slip));
    $('mSlip').classList.toggle('abn', this.alarms.isActive('BELT.SLIP'));
    $('mBeltEst').textContent = `${sh.beltSpeedEst.toFixed(3)} m/s`;
    $('mCurrent').textContent = `${Number(t['Drive.MotorCurrent']).toFixed(2)} / ${sh.currentModel.toFixed(2)} A`;
    $('mCurrent').classList.toggle('abn', this.alarms.isActive('M001.LOAD'));
    $('mWip').textContent = `${sh.tracks.length}`;
    $('sensorStrip').innerHTML = SENSOR_IDS.map((id, k) => {
      const on = Boolean(t[`Sensors.${id}`]);
      const status = sh.sensorSuspect[k] ? 'SUSPECT' : sh.blocked[k] ? 'BLOCKED' : 'OK';
      return `<div class="sensor ${status !== 'OK' ? 'abn' : ''}"><b>${SENSOR_LABEL[id]}</b><span class="io ${on ? 'on' : ''}">${on ? 'ON' : 'OFF'}</span><span>${status}</span></div>`;
    }).join('');

    $('healthVal').textContent = `${sh.health.toFixed(0)} %`;
    const fill = $('healthFill');
    fill.style.width = `${sh.health}%`;
    fill.classList.toggle('abn', sh.health < 70);
    const res = sh.currentResidual;
    $('healthNote').textContent =
      Math.abs(res) < 0.1
        ? `Measured current within ${Math.abs(res).toFixed(2)} A of the motor model — drive train nominal.`
        : `Measured current ${res > 0 ? '+' : ''}${res.toFixed(2)} A vs model → extra friction torque ≈ ${(res * MOTOR.Kt * 1000).toFixed(0)} mN·m at the motor shaft.`;

    const temp = Number(t['Drive.MotorTemp']);
    const th = sh.thermal;
    $('tNow').textContent = `${temp.toFixed(1)} °C`;
    $('tSs').textContent = `${th.steadyState.toFixed(1)} °C`;
    $('tSs').classList.toggle('abn', th.steadyState >= THERMAL.highAlarm);
    $('tHi').textContent = temp >= THERMAL.highAlarm ? 'reached' : th.toHighAlarm !== null ? fmtDuration(th.toHighAlarm) : 'not reached';
    $('tTrip').textContent = th.toTrip !== null ? fmtDuration(th.toTrip) : 'not reached';
    $('tTrip').classList.toggle('abn', th.toTrip !== null);
    const vmax = sh.maxSustainableSpeed();
    const sp = Number(t['Drive.SpeedSetpoint']);
    const adv = $('advisory');
    const overloaded = th.steadyState >= THERMAL.highAlarm - 3 || (vmax !== null && sp > vmax + 1e-6);
    if (overloaded && state === PackML.Execute && sh.currentResidual > 0.1) {
      adv.className = 'advisory abn';
      adv.textContent = vmax !== null
        ? `Advisory: reduce speed from ${sp.toFixed(2)} to ≤ ${vmax.toFixed(2)} m/s to hold the winding below ${THERMAL.highAlarm - 3} °C at the current load.`
        : 'Advisory: drive train cannot run continuously at any speed — schedule maintenance.';
    } else {
      adv.className = 'advisory';
      adv.textContent = `Thermal margin OK. Max sustainable speed at current load: ${vmax !== null ? `${vmax.toFixed(2)} m/s` : '—'}.`;
    }

    $('diagList').innerHTML = this.diagnostics(f).map((d) => `<li class="${d.abn ? 'abn' : ''}">${escapeHtml(d.text)}</li>`).join('');
  }

  private renderProduction(o: ReturnType<OeeTracker['snapshot']>): void {
    $('oeeVal').textContent = o.planned > 0 ? pct(o.oee) : '—';
    $('shiftInfo').textContent = `shift ${this.oee.shiftNo} · since ${hhmmss(this.oee.shiftStart)}`;
    $('apq').innerHTML = (
      [
        ['Availability', o.availability, 'run time / planned time'],
        ['Performance', o.performance, 'actual vs ideal rate'],
        ['Quality', o.quality, 'good / total'],
      ] as const
    )
      .map(([name, v, hint]) => `<div class="apq-row"><span>${name}<i>${hint}</i></span><div class="bar"><div style="width:${Math.min(100, v * 100)}%"></div></div><b>${o.planned > 0 ? pct(v) : '—'}</b></div>`)
      .join('');
    const tTotal = o.stateTimes.reduce((s, [, x]) => s + x, 0) || 1;
    $('timeBars').innerHTML =
      `<div class="stack">${o.stateTimes.map(([s, x]) => `<div title="${s} ${x.toFixed(0)} s" style="width:${(x / tTotal) * 100}%;background:${STATE_COLOR[s] ?? '#b9bec4'}"></div>`).join('')}</div>` +
      `<div class="stack-legend">${o.stateTimes.map(([s, x]) => `<span><i style="background:${STATE_COLOR[s] ?? '#b9bec4'}"></i>${s} ${fmtDuration(x)}</span>`).join('')}</div>`;
    $('timeKv').innerHTML = kv([
      ['Planned production time', fmtDuration(o.planned)],
      ['Run time (EXECUTE)', fmtDuration(o.run)],
      ['Downtime', fmtDuration(Math.max(0, o.planned - o.run))],
      ['Good / rejected', `${o.good} / ${o.rejected}`],
      ['Throughput (last 60 s)', `${o.ratePerMin.toFixed(1)} /min`],
    ]);

    // Production: energy
    const e = this.energy;
    $('ePower').textContent = `${e.powerW.toFixed(1)} W`;
    $('eShift').textContent = `${e.totalWh.toFixed(2)} Wh`;
    $('ePerCarton').textContent = e.perCartonJ !== null ? `${e.perCartonJ.toFixed(1)} J` : '—';
    $('eIdle').textContent = pct(e.idleShare, 0);
    $('eIdle').classList.toggle('abn', e.idleShare > 0.3 && e.totalWh > 0.05);
    const co2 = e.co2PerThousand;
    $('eNote').textContent =
      `Drive ${e.driveWh.toFixed(2)} Wh + control circuit ${e.controlWh.toFixed(2)} Wh (${CONTROL_POWER_W} W, always on).` +
      (co2 !== null ? ` ≈ ${co2.toFixed(1)} g CO₂e per 1000 good cartons at ${GRID_KG_CO2_PER_KWH} kg/kWh.` : '');
  }

  private renderSimulation(t: PlantFrame['tags']): void {
    $('fJam').classList.toggle('on', Boolean(t['Simulation.Jam']));
    $('fJam').textContent = t['Simulation.Jam'] ? 'Remove obstruction' : 'Obstruct zone 2';
    $('fRub').classList.toggle('on', Boolean(t['Simulation.GuideRub']));
    $('fRub').textContent = t['Simulation.GuideRub'] ? 'Realign zone-3 guide' : 'Misalign zone-3 guide';
    $('fEstop').classList.toggle('on', Boolean(t['Safety.ES001']));
    $('fEstop').textContent = t['Safety.ES001'] ? 'Release E-stop ES-001' : 'Press E-stop ES-001';
    $('truthKv').innerHTML = kv([
      ['True belt speed', `${Number(t['Simulation.BeltSpeedTrue']).toFixed(3)} m/s`],
      ['Actual slip', pct(Number(t['Simulation.Slip']))],
      ['Actual bearing wear', pct(Number(t['Simulation.BearingWear']), 0)],
      ['Zone-3 guide rub', t['Simulation.GuideRub'] ? 'YES' : 'no'],
      ['Defects escaped to outfeed', String(t['Simulation.EscapedDefects'])],
      ['Good cartons rejected', String(t['Simulation.FalseRejects'])],
      ['Simulation time', fmtDuration(Number(t['Simulation.SimTime']))],
    ]);
  }

  /** Live values on the 3D device tags (follows replay). */
  private updateViewTags(): void {
    const f = this.viewFrame();
    if (!f) return;
    const t = f.tags;
    const snap = this.replay.active ? this.recorder.at(this.replayTs()) : null;
    const suspect = snap?.sensorSuspect ?? this.shadow.sensorSuspect;
    const temp = Number(t['Drive.MotorTemp']);
    const values: TagValues = {
      M001: {
        text: `${Number(t['Drive.MotorCurrent']).toFixed(2)} A · ${temp.toFixed(0)} °C`,
        abn: temp >= THERMAL.highAlarm || this.alarms.isActive('M001.LOAD'),
      },
      ENC001: { text: `${Number(t['Drive.SpeedActual']).toFixed(3)} m/s` },
      VT001: { text: `${this.vibration.vRms.toFixed(2)} mm/s · ${this.vibration.zone.zone}`, abn: this.vibration.zone.zone >= 'C' },
      BELT: { text: `slip ${pct(Math.max(0, this.shadow.slip), 0)}`, abn: this.alarms.isActive('BELT.SLIP') },
      YV301: { text: `${t['Counters.Rejected']} rej` },
      HL001: {
        text: t['Actuators.HL001_Red'] ? 'RED' : t['Actuators.HL001_Amber'] ? 'AMBER' : t['Actuators.HL001_Green'] ? 'GREEN' : '—',
        abn: Boolean(t['Actuators.HL001_Red']),
      },
      ES001: { text: t['Safety.ES001'] ? 'ENGAGED' : 'OK', abn: Boolean(t['Safety.ES001']) },
    };
    SENSOR_IDS.forEach((id, k) => {
      values[id] = { text: t[`Sensors.${id}`] ? 'ON' : 'OFF', abn: suspect[k] || this.shadow.blocked[k] };
    });
    const fused = this.visionStation.stats.last?.verdict;
    values.CAM201 = { text: fused ? `tunnel ${fused === 'NO_READ' ? 'NO READ' : fused}` : '5 cams', abn: fused === 'NO_READ' || fused === 'DEFECT' };
    this.scene.setTagValues(values);
  }

  private diagnostics(f: PlantFrame): { text: string; abn: boolean }[] {
    const sh = this.shadow;
    const out: { text: string; abn: boolean }[] = [];
    for (let zone = 1; zone <= 3; zone++) {
      if (sh.overdueInZone[zone] > 0) {
        out.push({ text: `Zone ${zone}: ${sh.overdueInZone[zone]} carton(s) overdue at ${SENSOR_LABEL[SENSOR_IDS[zone]]}.`, abn: true });
      }
    }
    SENSOR_IDS.forEach((id, k) => {
      if (sh.blocked[k]) out.push({ text: `${SENSOR_LABEL[id]} blocked for more than 3 carton lengths of belt travel — accumulation.`, abn: true });
      if (sh.sensorSuspect[k]) out.push({ text: `${SENSOR_LABEL[id]} suspected failed: cartons arrive downstream without its edge.`, abn: true });
    });
    if (sh.slip > 0.04) {
      const v = Number(f.tags['Drive.SpeedActual']);
      out.push({ text: `Encoder reports ${v.toFixed(3)} m/s but cartons travel at ${sh.beltSpeedEst.toFixed(3)} m/s → slip ${pct(sh.slip)}.`, abn: true });
    }
    if (sh.currentResidual > 0.3) out.push({ text: `Motor draws ${sh.currentResidual.toFixed(2)} A more than the model predicts for this speed and load.`, abn: true });
    const u = this.unexplainedAnomaly();
    if (u) {
      out.push({
        text: `Unknown fault: only the learned model sees it — ${u.signal} drives ${(u.share * 100).toFixed(0)} % of the deviation (check ${u.asset}).`,
        abn: true,
      });
    }
    if (!out.length) out.push({ text: 'All zones nominal — every carton accounted for, residuals inside limits.', abn: false });
    for (const n of sh.notes.slice(0, 3)) out.push({ text: n, abn: false });
    return out;
  }

  private updateAlarms(): void {
    const counts = this.alarms.counts();
    $('alarmSummary').innerHTML = ([1, 2, 3] as Priority[])
      .map((p) => `<span class="as ${counts[p] ? 'on' : ''}"><i class="pri ${PRIORITY_SHAPE[p]} p${p}">${p}</i>${counts[p]}</span>`)
      .join('');
    if (this.alarms.version === this.alarmVersion) return;
    this.alarmVersion = this.alarms.version;

    const list = this.alarms.sorted();
    $('alarmCount').textContent = list.length ? String(list.length) : '';
    $('alarmBody').innerHTML = list.length
      ? list
          .map(
            (a) => `<tr class="${a.state === 'UNACK' ? 'unack' : ''} ${a.state === 'RTN_UNACK' ? 'rtn' : ''}">
              <td><i class="pri ${PRIORITY_SHAPE[a.priority]} p${a.priority} ${a.state === 'UNACK' ? 'unack-blink' : ''}">${a.priority}</i></td>
              <td class="mono">${hhmmss(a.activeSince)}</td>
              <td class="mono">${escapeHtml(a.tag)}</td>
              <td>${escapeHtml(a.text)}${a.detail ? ` <span class="muted">${escapeHtml(a.detail)}</span>` : ''}</td>
              <td class="mono">${a.state === 'UNACK' ? 'ACTIVE · UNACK' : a.state === 'ACKED' ? 'ACTIVE · ACK' : 'RTN · UNACK'}</td>
              <td>${a.state !== 'ACKED' ? `<button class="mini" data-ack="${a.id}">Ack</button>` : ''}</td>
            </tr>`,
          )
          .join('')
      : '<tr class="empty"><td colspan="6">No active alarms</td></tr>';

    // Banner: newest highest-priority alarm awaiting acknowledgement
    const banner = $('alarmBanner');
    const top = this.alarms.topUnacked();
    const unacked = list.filter((a) => a.state !== 'ACKED').length;
    if (!top) {
      const active = list.length;
      banner.className = 'alarm-banner idle';
      banner.textContent = active ? `${active} active alarm${active > 1 ? 's' : ''} — all acknowledged` : 'No unacknowledged alarms';
    } else {
      banner.className = `alarm-banner p${top.priority}`;
      banner.innerHTML = `<i class="pri ${PRIORITY_SHAPE[top.priority]} p${top.priority} ${top.state === 'UNACK' ? 'unack-blink' : ''}">${top.priority}</i>
        <span class="mono">${hhmmss(top.activeSince)}</span>
        <span class="mono muted">${escapeHtml(top.tag)}</span>
        <span class="ab-text">${escapeHtml(top.text)}${top.detail ? ` — ${escapeHtml(top.detail)}` : ''}${top.state === 'RTN_UNACK' ? ' (returned to normal)' : ''}</span>
        <span class="ab-more">${unacked > 1 ? `+${unacked - 1} more unacknowledged` : ''}</span>
        <button data-ack="${top.id}">Acknowledge</button>`;
    }

    if (this.journalVisible) {
      $('journal').innerHTML = this.alarms.journal
        .slice(0, 200)
        .map((j) => `<div class="j j-${j.kind.toLowerCase()}"><span class="mono">${hhmmss(j.ts)}</span><b>${j.kind}</b><span class="src">${escapeHtml(j.source)}</span><span>${escapeHtml(j.text)}</span></div>`)
        .join('');
    }
  }

  private updateTrends(): void {
    const keys: HistKey[] = ['sp', 'v', 'vEst', 'i', 'iModel', 'temp', 'slip', 'ires', 'power'];
    const [t, sp, v, vEst, i, iModel, temp, slip, ires, power] = this.hist.window(this.trendRange, keys);
    this.trends.drive.setData([t, sp, v, vEst]);
    this.trends.motor.setData([t, i, iModel, temp]);
    this.trends.twin.setData([t, slip, ires]);
    if (this.visible('prod')) this.energyChart.setData([t, power]);
  }

  // ───────────────────────────── SPC ─────────────────────────────

  private updateSpc(): void {
    const draw = this.visible('spc');
    const render = (chart: ControlChart, plot: TrendChart, statusId: string, limitsId: string, unit: string, d: number, def: AlarmDef) => {
      const status = chart.status;
      const sig = chart.lastSignal;
      this.alarms.set(def, status === 'OUT OF CONTROL', sig ? `${sig.rule}: ${RULE_TEXT[sig.rule!]}` : '');
      if (!draw) return;
      const s = chart.samples;
      const L = chart.limits;
      const line = (v: number | undefined): Series => s.map(() => (v === undefined ? null : v));
      plot.setData([
        s.map((x) => x.n),
        s.map((x) => x.value),
        line(L?.centre),
        line(L?.ucl),
        line(L?.lcl),
        s.map((x) => (x.rule ? x.value : null)),
      ]);
      $(statusId).innerHTML =
        status === 'COLLECTING'
          ? `<span class="spc-chip collect">COLLECTING BASELINE ${chart.collected}/${chart.baselineSize}</span><span class="muted">limits are computed from the first ${chart.baselineSize} samples</span>`
          : `<span class="spc-chip ${status === 'OUT OF CONTROL' ? 'ooc' : ''}">${status}</span>` +
            (sig ? `<span class="muted">last signal ${sig.rule}: ${RULE_TEXT[sig.rule!]} · ${hhmmss(sig.ts)}</span>` : '<span class="muted">no rule violations</span>');
      $(limitsId).textContent = L
        ? `CL ${L.centre.toFixed(d)} · UCL ${L.ucl.toFixed(d)} · LCL ${L.lcl.toFixed(d)} · σ ${L.sigma.toFixed(d)} ${unit}`
        : '';
    };
    render(this.spcDrive, this.spcCharts.drive, 'spcDriveStatus', 'spcDriveLimits', 'A', 3, SPC_ALARMS.drive);
    render(this.spcQual, this.spcCharts.qual, 'spcQualStatus', 'spcQualLimits', '', 3, SPC_ALARMS.quality);
  }

  // ───────────────────────────── maintenance ─────────────────────────────

  /** A learned-model anomaly that none of the rule-based diagnoses explains. */
  private unexplainedAnomaly(): { asset: string; signal: string; share: number } | null {
    const top = this.anomaly.last?.contributions[0];
    if (this.anomaly.status !== 'ANOMALY' || !top) return null;
    for (const a of this.alarms.alarms.values()) if (a.state !== 'RTN_UNACK' && isRuleDiagnosis(a.id)) return null;
    return { asset: top.asset, signal: top.name, share: top.share };
  }

  private evaluateMaintenance(): void {
    const sh = this.shadow;
    const created = this.maintenance.evaluate(
      {
        health: sh.health,
        currentResidual: sh.currentResidual,
        rulS: this.rulEst?.rulS ?? null,
        slip: sh.slip,
        slipAlarm: this.alarms.isActive(ALARMS.slip.id),
        sensorSuspect: sh.sensorSuspect,
        visionCamera: this.alarms.isActive(ALARMS.vision.id) ? this.supervisor.visionNoReadCamera || 'CAM-201' : null,
        jamCount: this.supervisor.jamCount,
        tripped: this.alarms.isActive(ALARMS.trip.id),
        unexplained: this.unexplainedAnomaly(),
      },
      Date.now(),
    );
    for (const o of created) {
      this.alarms.log('MAINT', o.id, `Work order raised (${o.priority}): ${o.title} — ${o.reason}`);
      toast(`${o.id} raised · ${o.asset}: ${o.title}`);
    }
  }

  private raiseManualOrder(asset: string): void {
    const o = this.maintenance.raise({
      key: `MAN-${asset}-${Date.now()}`,
      asset,
      title: `Operator request: inspect ${asset}`,
      reason: 'Raised from the device faceplate',
      priority: 'Low',
      source: 'Operator',
      repair: [],
    });
    if (o) {
      this.alarms.log('MAINT', o.id, `Work order raised by operator for ${asset}`);
      this.renderMaintenance(false);
    }
  }

  private workOrderAction(id: string, act: 'start' | 'done'): void {
    const o = act === 'start' ? this.maintenance.start(id) : this.maintenance.complete(id);
    if (!o) return;
    if (act === 'start') {
      this.alarms.log('MAINT', o.id, `Work started on ${o.asset}`);
    } else {
      for (const [fault, value] of o.repair) {
        void this.link.call('SetFault', fault, value);
        this.syncSimControl(fault, value);
      }
      const zone = /^ZONE(\d)-JAM$/.exec(o.key);
      if (zone) this.supervisor.jamCount[Number(zone[1])] = 0;
      if (o.asset === 'M-001') {
        // The process changed (repair) — establish new limits and a new degradation trend
        this.spcDrive.rebaseline();
        this.rul.reset();
        this.vibration.reset();
        this.alarms.log('TWIN', 'SPC', `Drive-current limits re-baselined after ${o.id}`);
      }
      const repair = o.repair.map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ');
      this.alarms.log('MAINT', o.id, `Completed on ${o.asset}${repair ? ` — repair applied in virtual plant (${repair})` : ''}`);
      toast(`${o.id} completed — ${o.asset} repaired`);
    }
    this.renderMaintenance(false);
  }

  /** `periodic` refreshes only the condition columns unless orders changed. */
  private renderMaintenance(periodic: boolean): void {
    const m = this.maintenance;
    const sh = this.shadow;
    const active = m.openCount + m.inProgressCount;
    $('woCount').textContent = active ? String(active) : '';
    if (!this.visible('maint')) return;
    $('woKpis').innerHTML = [
      ['Open', String(m.openCount)],
      ['In progress', String(m.inProgressCount)],
      ['Completed', String(m.doneCount)],
      ['MTTR', m.mttr !== null ? fmtDuration(m.mttr) : '—'],
    ]
      .map(([k, v]) => `<div class="metric"><span>${k}</span><b>${v}</b></div>`)
      .join('');

    const rul = this.rulEst?.rulS;
    const assets: [string, string, string, boolean][] = [
      [
        'M-001',
        'Drive gearmotor',
        `${sh.health.toFixed(0)} % · ISO ${this.vibration.zone.zone}${rul !== null && rul !== undefined ? ` · RUL ${fmtDuration(rul)}` : ''}`,
        sh.health < 70 || this.vibration.zone.zone >= 'C' || (rul !== null && rul !== undefined && rul < 150),
      ],
      ['BELT', 'Conveyor belt', `${pct(Math.max(0, sh.slip), 0)} slip`, this.alarms.isActive(ALARMS.slip.id)],
      ...SENSOR_IDS.map((id, k): [string, string, string, boolean] => [SENSOR_LABEL[id], 'Photo-eye', sh.sensorSuspect[k] ? 'Suspect' : 'OK', sh.sensorSuspect[k]]),
      ['ENC-001', 'Encoder', 'OK', false],
      ...CAMERAS.map((c): [string, string, string, boolean] => {
        const st = this.visionStation.stats.perCam[c.id];
        const bad = st.last === 'NO_READ';
        return [c.label, `Camera · ${c.face}`, bad ? 'No-read' : `${st.defects} defects`, bad];
      }),
      ['YV-301', 'Pusher valve', `${m.pusherCycles} cycles`, false],
    ];
    $('assetTable').innerHTML =
      '<thead><tr><th>Asset</th><th>Type</th><th>Condition</th><th>WO</th></tr></thead><tbody>' +
      assets
        .map(([a, type, cond, abn]) => {
          const n = m.openFor(a);
          return `<tr class="${abn ? 'abn' : ''}"><td class="mono">${a}</td><td>${type}</td><td>${cond}</td><td>${n ? `<span class="count">${n}</span>` : ''}</td></tr>`;
        })
        .join('') +
      '</tbody>';

    if (periodic && m.version === this.woVersion) return;
    this.woVersion = m.version;
    $('woList').innerHTML = m.orders.length
      ? m.orders.map((o) => woCard(o)).join('')
      : '<div class="wo-empty">No work orders. The twin raises them automatically from persistent asset conditions.</div>';
  }

  // ───────────────────────────── address space ─────────────────────────────

  private buildTagTable(): void {
    $('nsInfo').textContent = NAMESPACE.split(';')[0];
    let folder = '';
    const rows: string[] = ['<thead><tr><th>Browse path</th><th>Value</th><th>Unit</th><th>Type</th></tr></thead><tbody>'];
    for (const d of TAG_DEFS) {
      const [f, name] = d.path.split('.');
      if (f !== folder) {
        folder = f;
        rows.push(`<tr class="folder ${f === 'Simulation' ? 'sim' : ''}"><td colspan="4">▾ ${f}${f === 'Simulation' ? ' <span class="muted">(virtual plant only)</span>' : ''}</td></tr>`);
      }
      rows.push(
        `<tr data-path="${d.path}" class="${f === 'Simulation' ? 'sim' : ''}" title="${escapeHtml(nodeId(d.path))}\n${escapeHtml(d.desc)}">
          <td>${name}${d.writable ? ' <span class="rw">RW</span>' : ''}</td><td class="mono val"></td><td>${d.unit ?? ''}</td><td class="muted">${d.type}</td></tr>`,
      );
    }
    rows.push('</tbody>');
    const table = $('tagTable');
    table.innerHTML = rows.join('');
    table.querySelectorAll<HTMLTableRowElement>('tr[data-path]').forEach((tr) => {
      this.tagCells.set(tr.dataset.path!, tr.querySelector('.val')!);
    });
  }

  // ───────────────────────────── what-if ─────────────────────────────

  /** Initial condition for model runs — from the twin's own estimates (residuals), not simulator ground truth. */
  private scenarioBase(): Omit<Scenario, 'speed'> | null {
    const t = this.link.frame?.tags;
    if (!t) return null;
    const fromState = $<HTMLInputElement>('wiState').checked;
    return {
      horizonMin: Number($<HTMLSelectElement>('wiHorizon').value),
      temperature: fromState ? Number(t['Drive.MotorTemp']) : THERMAL.initial,
      wear: fromState ? Math.min(1, Math.max(0, this.shadow.currentResidual) / ((5 * MOTOR.Tc) / MOTOR.Kt)) : 0,
      slip: fromState ? Math.max(0, this.shadow.slip) : 0,
      defectRate: Number(t['Simulation.DefectRate']),
    };
  }

  private applySpeed(v: number): void {
    void this.command('SetSpeed', v);
    $<HTMLInputElement>('spInput').value = v.toFixed(2);
    $<HTMLInputElement>('spRange').value = String(v);
  }

  private runWhatIf(): void {
    const base = this.scenarioBase();
    if (!base) return;
    const proposed = Number($<HTMLInputElement>('wiSpeed').value);
    const current = Number(this.link.tag('Drive.SpeedSetpoint'));
    const horizon = base.horizonMin;
    const btn = $<HTMLButtonElement>('wiRun');
    btn.disabled = true;
    $('wiStatus').textContent = `Simulating 2 × ${horizon} min of plant time…`;
    setTimeout(() => {
      const a = runScenario({ ...base, speed: current });
      const b = runScenario({ ...base, speed: proposed });
      this.whatIfResult = { base: a, prop: b };
      btn.disabled = false;
      $<HTMLButtonElement>('wiApply').disabled = false;
      const ms = a.wallMs + b.wallMs;
      $('wiStatus').textContent = `Done — ${2 * horizon} min of plant time in ${ms.toFixed(0)} ms (${((2 * horizon * 60000) / ms).toFixed(0)}× real time). Wear ${pct(base.wear, 0)} and slip ${pct(base.slip, 0)} taken from twin estimates.`;
      this.renderWhatIf(a, b);
    }, 30);
  }

  private renderWhatIf(a: ScenarioResult, b: ScenarioResult): void {
    type Row = [string, (r: ScenarioResult) => number | null, (v: number) => string, 'hi' | 'lo'];
    const rows: Row[] = [
      ['Good cartons / h', (r) => r.throughputPerH, (v) => v.toFixed(0), 'hi'],
      ['OEE', (r) => r.oee, (v) => pct(v), 'hi'],
      ['Availability', (r) => r.availability, (v) => pct(v), 'hi'],
      ['Quality', (r) => r.quality, (v) => pct(v), 'hi'],
      ['Energy / good carton', (r) => r.energyPerCartonJ, (v) => `${v.toFixed(1)} J`, 'lo'],
      ['Peak winding temp', (r) => r.peakTemp, (v) => `${v.toFixed(1)} °C`, 'lo'],
    ];
    const cell = (v: number | null, other: number | null, better: 'hi' | 'lo', fmt: (v: number) => string) => {
      if (v === null) return '<td>—</td>';
      const win = other !== null && (better === 'hi' ? v > other * 1.005 : v < other * 0.995);
      return `<td class="${win ? 'better' : ''}">${fmt(v)}</td>`;
    };
    $('wiTable').innerHTML =
      `<thead><tr><th></th><th>Current ${a.speed.toFixed(2)} m/s</th><th>Proposed ${b.speed.toFixed(2)} m/s</th></tr></thead><tbody>` +
      rows.map(([name, get, fmt, better]) => `<tr><th>${name}</th>${cell(get(a), get(b), better, fmt)}${cell(get(b), get(a), better, fmt)}</tr>`).join('') +
      `<tr><th>Over-temp trip</th>${[a, b].map((r) => `<td class="${r.tripAtMin !== null ? 'abn' : ''}">${r.tripAtMin !== null ? `after ${r.tripAtMin.toFixed(1)} min` : 'none'}</td>`).join('')}</tr></tbody>`;

    const host = $('wiChart');
    host.innerHTML = '';
    this.wiChart = new TrendChart(
      host,
      'Winding temperature forecast (min)',
      [
        { label: `${a.speed.toFixed(2)} m/s`, color: '--pen-ref', decimals: 1 },
        { label: `${b.speed.toFixed(2)} m/s`, color: '--pen-1', decimals: 1 },
      ],
      [{ scale: 'C', label: '°C', range: [20, 100] }],
      false,
    );
    this.wiChart.setData([a.temps[0], a.temps[1], b.temps[1]]);
  }

  // ───────────────────────────── report ─────────────────────────────

  private exportReport(): void {
    const o = this.oee.snapshot();
    const e = this.energy;
    const t = this.link.frame?.tags ?? {};
    const csv = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const lines = [
      'Conveyor 01 — Shift report',
      `Node,${NAMESPACE}`,
      `Shift,${this.oee.shiftNo}`,
      `Shift start,${new Date(this.oee.shiftStart).toISOString()}`,
      `Report time,${new Date().toISOString()}`,
      '',
      'KPI,Value',
      `OEE,${(o.oee * 100).toFixed(2)} %`,
      `Availability,${(o.availability * 100).toFixed(2)} %`,
      `Performance,${(o.performance * 100).toFixed(2)} %`,
      `Quality,${(o.quality * 100).toFixed(2)} %`,
      `Planned time [s],${o.planned.toFixed(0)}`,
      `Run time [s],${o.run.toFixed(0)}`,
      `Good,${o.good}`,
      `Rejected,${o.rejected}`,
      `Energy [Wh],${e.totalWh.toFixed(3)}`,
      `Energy per good carton [J],${e.perCartonJ?.toFixed(2) ?? ''}`,
      `Idle energy share,${(e.idleShare * 100).toFixed(1)} %`,
      `Motor health index,${this.shadow.health.toFixed(0)} %`,
      `Motor temperature,${t['Drive.MotorTemp']} °C`,
      `SPC drive current,${this.spcDrive.status}`,
      `SPC reject rate,${this.spcQual.status}`,
      `Learned anomaly model,${this.anomaly.status}`,
      `Drive-train RUL [s],${this.rulEst?.rulS?.toFixed(0) ?? 'no trend'}`,
      `Cartons inspected (5 cameras),${this.visionStation.stats.inspected}`,
      `Rejected as defect,${this.visionStation.stats.defects}`,
      `Defects missed by top camera alone,${this.visionStation.stats.missedByTop}`,
      `Fail-safe no-reads,${this.visionStation.stats.noReads}`,
      '',
      'State,Duration [s]',
      ...o.stateTimes.map(([s, x]) => `${s},${x.toFixed(1)}`),
      '',
      'Work order,Asset,Priority,Status,Title,Reason,Created,Completed',
      ...this.maintenance.orders.map((w) =>
        [w.id, w.asset, w.priority, w.status, csv(w.title), csv(w.reason), new Date(w.created).toISOString(), w.completed ? new Date(w.completed).toISOString() : ''].join(','),
      ),
      '',
      'Time,Kind,Source,Text',
      ...this.alarms.journal.map((j) => `${new Date(j.ts).toISOString()},${j.kind},${j.source},${csv(j.text)}`),
    ];
    download(`conveyor01_shift${this.oee.shiftNo}_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.csv`, lines.join('\n'));
    this.alarms.log('EVENT', 'OEE', 'Shift report exported');
  }
}

function kv(rows: [string, string][]): string {
  return rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('');
}

function woCard(o: WorkOrder): string {
  const meta =
    o.status === 'DONE'
      ? `completed ${hhmmss(o.completed!)} · repair time ${fmtDuration((o.completed! - o.created) / 1000)}`
      : `raised ${hhmmss(o.created)} by ${o.source} · ${o.priority} priority`;
  const actions =
    o.status === 'DONE'
      ? ''
      : `<div class="wo-actions">
          ${o.status === 'OPEN' ? `<button data-wo-act="start" data-wo-id="${o.id}">Start work</button>` : ''}
          <button class="primary" data-wo-act="done" data-wo-id="${o.id}">Complete</button>
        </div>`;
  return `<div class="wo prio-${o.priority.toLowerCase()} ${o.status === 'DONE' ? 'done' : ''}">
    <div class="wo-top"><span class="wo-id">${o.id} · ${escapeHtml(o.asset)}</span><span class="wo-status">${o.status}</span></div>
    <div class="wo-title">${escapeHtml(o.title)}</div>
    <div class="wo-meta">${escapeHtml(o.reason)}</div>
    <div class="wo-meta">${meta}</div>
    ${actions}
  </div>`;
}
