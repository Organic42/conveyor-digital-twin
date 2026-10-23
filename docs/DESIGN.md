# Digital Twin of a Mini Conveyor Belt — System Design

**Course:** Industrial IoT Engineering — Mini Project
**Approach:** Virtual commissioning (software-in-the-loop). A physics-based virtual plant stands in for the
physical conveyor and is exposed only through industrial protocols. The digital twin never reads simulator
internals — it sees exactly what it would see from real hardware.

---

## 1. Goals

| # | Goal | How we prove it in the demo |
|---|------|-----------------------------|
| G1 | Twin mirrors plant state in real time (< 200 ms latency) | Latency readout in HMI status bar |
| G2 | Bidirectional: operator commands from twin reach the plant | Start/Stop/Speed/Reset from HMI |
| G3 | Twin runs its **own model** and detects deviation from the plant | Injected belt slip → residual alarm |
| G4 | Vision-based quality inspection with automatic reject | Defective items are pushed off at reject station |
| G5 | Production KPIs: OEE, throughput, shift reports | OEE panel + exported shift report |
| G6 | Predictive maintenance | Motor thermal/current trend → time-to-alarm estimate |
| G7 | What-if analysis faster than real time | "Simulate 1 h at 0.6 m/s" → predicted OEE before applying |

Non-goals: safety-rated control (E-stop is modelled, not certified), cloud deployment, multi-line plant.

---

## 2. Reference Plant (what we are twinning)

A 1.2 m benchtop inspection & reject conveyor.

```
  Infeed                 Vision              Reject                Outfeed
   PE-101 ───────────────  CAM-201 / PE-201 ───  PE-301  YV-301 ────── PE-401
   │0.10 m                 │0.50 m               │0.85 m  (pusher)     │1.15 m
   ▼                       ▼                     ▼                     ▼
 ══════════════════════════════════════════════════════════════════════════  belt 1.2 m
 (M-001 24 V DC gearmotor + ENC-001 on drive roller)          Stack light HL-001, E-stop ES-001
```

| Tag prefix | Device (industrial reference part) | Signal |
|---|---|---|
| M-001 | 24 V DC geared motor, 60 W, 1:20 gearbox | PWM command, current feedback |
| ENC-001 | Incremental encoder, 600 PPR, 24 V HTL | pulses → belt speed |
| PE-101/201/301/401 | Diffuse photoelectric sensor, 24 V PNP | DI (with debounce) |
| CAM-201 | Industrial camera at inspection station | frames → vision node |
| YV-301 | 24 V solenoid valve + pneumatic pusher | DO, stroke 150 ms |
| TT-001 | Motor winding temperature (PT100) | AI °C |
| HL-001 | Stack light R/A/G + buzzer | DO ×4 |
| ES-001 | E-stop, 2-channel NC | DI |

Tag naming follows ISA-5.1 style instrument identifiers; the OPC UA address space follows the ISA-95
hierarchy `Enterprise/Site/Area/Line/Cell/Equipment`.

---

## 3. Architecture

```
┌──────────────────────────────── Level 0–1: Virtual Plant ────────────────────────────────┐
│  plant-sim (Python)                                                                       │
│   • Fixed-step physics @ 50 Hz: motor electro-mech model, belt kinematics, items          │
│   • Sensor models: noise, debounce, quantisation, faults                                  │
│   • Control logic: PackML state machine, interlocks, reject timing (like PLC code)        │
│   • OPC UA server  opc.tcp://localhost:4840  (address space = ISA-95 tree)                │
└──────────────────────────────────────┬────────────────────────────────────────────────────┘
                                       │ OPC UA subscriptions (100 ms) + method calls
┌──────────────────────────── Level 2–3: Twin Service ─────────────────────────────────────┐
│  twin-service (Python, FastAPI)                                                          │
│   • OPC UA client → Twin state (shadow)                                                  │
│   • Twin model: independent kinematic/thermal model, residuals vs plant                  │
│   • Analytics: OEE, jam/slip detection, motor health + time-to-alarm                     │
│   • Alarm manager (ISA-18.2 lifecycle: Active-Unack → Ack → RTN)                         │
│   • Vision node: OpenCV inspection of rendered camera frames                             │
│   • Historian: SQLite time-series, shift reports, replay                                 │
│   • What-if engine: runs a copy of the plant model at 100× real time                     │
│   • MQTT publisher → Unified Namespace  plant/<site>/<area>/<line>/conv01/...            │
│   • REST + WebSocket API to the HMI                                                       │
└──────────────────────────────────────┬────────────────────────────────────────────────────┘
                                       │ WebSocket (state @ 10 Hz) + REST (commands, history)
┌──────────────────────────── Level 3: Twin HMI ───────────────────────────────────────────┐
│  twin-ui (TypeScript, Vite, Three.js, uPlot)                                              │
│   • 3D twin of the conveyor to scale; items, sensors light up, pusher animates             │
│   • Virtual camera renders inspection frames → sent to vision node                        │
│   • ISA-101 high-performance HMI style (grey base, colour = abnormal only)                │
│   • Panels: Overview, Trends, Alarms, OEE/Shift, Predictive, What-if, Fault injection      │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

**Key design rule:** the twin talks to the plant only over OPC UA. Replacing `plant-sim` with a real PLC
exposing the same address space would need zero code changes in the twin. This is the virtual
commissioning argument for the presentation.

---

## 4. Plant Model (plant-sim)

### 4.1 Motor (armature-controlled DC motor)
```
L·di/dt = V − R·i − Ke·ω            V = duty · 24 V
J·dω/dt = Kt·i − b·ω − T_load       T_load = (μ·m_items·g + F_friction)·r_roller / N_gear
```
Parameters are chosen for a 60 W, 24 V motor (R ≈ 1.2 Ω, Kt = Ke ≈ 0.05, N = 20).

### 4.2 Belt and items
- Belt speed `v = ω_out · r_roller · (1 − s)`, slip `s` normally ≈ 0, raised by fault injection.
- Items: id, type (good / defect: colour or size), position, length. Items are spawned at infeed by a
  Poisson process (configurable rate). An item sticks at a position when a jam is injected.

### 4.3 Sensors
- Photo-eyes: beam broken when item overlaps sensor x; 5 ms debounce; fault modes stuck-on / stuck-off.
- Encoder: pulse count from roller angle, speed computed over a 100 ms window (quantisation is real).
- Current: `i` + Gaussian noise. Temperature: first-order thermal model `C·dT/dt = i²R − (T−T_amb)/R_th`.

### 4.4 Control logic (the "PLC program")
PackML-based state machine: `STOPPED → STARTING → EXECUTE ⇄ HELD`, `ABORTED` on E-stop,
`CLEARING → STOPPED` on reset. Interlocks: no start while E-stop active or over-temperature.
Reject logic: vision verdict at PE-201 is tracked by encoder distance (shift register) and the pusher fires
when the item reaches the reject station — same technique used on real reject conveyors.

---

## 5. Twin Service

### 5.1 Shadow model and residuals (what makes it a twin, not a dashboard)
The twin keeps its own item tracking from the commanded speed and PE-101 entry events, and predicts when
each item should arrive at PE-201/301/401. Comparing predicted with actual arrival gives a residual:

| Residual | Meaning | Alarm |
|---|---|---|
| arrival late, speed normal | item stuck | JAM at zone |
| encoder speed < model speed | belt slip / mechanical wear | SLIP |
| current > model current at same load | rising friction / bearing wear | MOTOR LOAD HIGH |
| sensor never triggers | sensor failure | PE-xxx FAULT |

### 5.2 Analytics
- **OEE** = Availability × Performance × Quality, computed per shift from state durations, ideal cycle
  time, and good/reject counts.
- **Predictive:** linear and exponential fit of motor temperature trend → estimated minutes until high-temp
  alarm; current-at-speed baseline → health index 0–100 %.

### 5.3 Alarm management (ISA-18.2)
Priority (High/Med/Low), states (Active-Unacknowledged, Active-Acknowledged, RTN-Unacknowledged, Normal),
shelving, timestamped event journal.

### 5.4 Vision node
The HMI renders the inspection camera view from the 3D scene at PE-201 trigger and POSTs the frame.
OpenCV pipeline: ROI crop → HSV threshold → contour → area/colour checks → verdict GOOD / DEFECT
(+ confidence, processing ms). The verdict goes back to the plant via OPC UA method `Inspection.Report`.

### 5.5 What-if engine
Clones the current plant parameters, runs the physics model headless at about 100× real time for a chosen
horizon with modified setpoints (speed, infeed rate), and returns predicted throughput, OEE, and peak
motor temperature, so the operator can compare before applying a change.

### 5.6 Historian
SQLite table `(ts, tag, value)` sampled at 1 Hz plus an event table. Supports trend queries, shift report
export (CSV/PDF-ready HTML) and timeline replay in the HMI.

---

## 6. Interfaces

### 6.1 OPC UA address space (excerpt)
```
Objects/
 └ DemoPlant (Site) / Area1 / Line1 / Conveyor01
     ├ State            (PackML state, Int32)
     ├ Drive/ SpeedSetpoint [m/s, RW], SpeedActual, MotorCurrent, MotorTemp, Duty
     ├ Sensors/ PE101..PE401 (Bool), EncoderCount (UInt32)
     ├ Actuators/ Pusher (Bool), StackLight/{Red,Amber,Green,Buzzer}
     ├ Safety/ EStop (Bool)
     ├ Counters/ Infeed, Good, Rejected, Outfeed
     ├ Methods: Start(), Stop(), Hold(), Reset(), SetSpeed(v), ReportInspection(id, verdict)
     └ Simulation/ (fault injection — only present in the virtual plant)
```

### 6.2 MQTT Unified Namespace
`mesh/site1/area1/line1/conv01/<group>/<tag>` with JSON payloads `{ "v": 0.42, "ts": 1729..., "q": "GOOD" }`
(quality codes as in OPC UA). Retained `state` topic; alarms on `.../alarms`.

### 6.3 HMI API
`WS /ws/live` (10 Hz state frame), `POST /api/cmd/{start|stop|hold|reset|speed}`,
`GET /api/history?tag=&from=&to=`, `GET /api/oee?shift=`, `POST /api/whatif`, `POST /api/vision/frame`,
`POST /api/faults`.

---

## 7. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Plant sim | Python 3.12, numpy | readable physics, fast enough at 50 Hz |
| OPC UA | `asyncua` | open-source, standard-compliant server and client |
| MQTT | `amqtt` (embedded broker) + `paho-mqtt` | no separate install on Windows |
| Twin service | FastAPI + uvicorn | async, WebSocket built in |
| Vision | OpenCV | classical, explainable pipeline |
| Historian | SQLite | zero setup, SQL queries for reports |
| HMI | TypeScript + Vite + Three.js + uPlot | 3D twin + high-rate trends |

Run with one command: `python run.py` starts plant-sim, twin-service and the UI build.

---

## 8. Repository Layout
```
plant_sim/      physics.py, sensors.py, control.py (PackML), opcua_server.py, faults.py
twin_service/   opcua_client.py, shadow.py, analytics.py, alarms.py, vision.py,
                historian.py, whatif.py, mqtt_uns.py, api.py
twin_ui/        src/scene/ (Three.js), src/panels/, src/hmi.css
docs/           DESIGN.md, SLIDES_OUTLINE.md, diagrams/
tests/          physics + residual + OEE unit tests
run.py
```

---

## 9. Two-Week Plan

| Day | Work |
|---|---|
| 1–2 | Plant physics, sensors, PackML control, OPC UA server; unit tests on motor model |
| 3–4 | Twin service: OPC UA client, live WebSocket, historian, alarm manager |
| 5–7 | HMI: 3D scene to scale, live mirroring, controls, trends, alarm list |
| 8 | Shadow model + residual-based jam/slip/sensor-fault detection; fault-injection panel |
| 9 | Vision node + virtual camera + reject tracking |
| 10 | OEE, shift report, predictive health |
| 11 | What-if engine and comparison UI |
| 12 | MQTT UNS, polish, latency/perf checks |
| 13–14 | Screenshots, slides, demo rehearsal, buffer |

---

## 10. Demo Script (≈ 6 min)
1. Architecture slide, then open the HMI: plant STOPPED, everything grey (ISA-101).
2. Start the line from the twin; items flow; 3D, counters and trends update live.
3. Vision rejects a red (defective) item; pusher fires in 3D; quality drops in OEE.
4. Inject **belt slip** → twin residual raises SLIP alarm before throughput visibly drops.
5. Inject **jam** at zone 2 → JAM alarm, stack light red, line goes HELD; acknowledge, clear, reset.
6. Predictive panel: raise motor load → temperature trend → "high-temp in ~7 min".
7. What-if: compare 0.30 vs 0.45 m/s for 1 h → predicted OEE and temperature, then apply.
8. Close with the shift report and the "swap simulator for real PLC, twin unchanged" argument.
