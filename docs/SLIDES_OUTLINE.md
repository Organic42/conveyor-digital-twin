# Presentation Outline — Digital Twin of a Mini Conveyor Belt

Target: 15–18 slides, about 12 min talk + 6 min live demo.

1. **Title.** Digital Twin of a Mini Conveyor Belt: virtual commissioning with OPC UA. Team, guide, date.
2. **Problem statement.** Conveyors are the backbone of discrete manufacturing. Unplanned stops from jams,
   slip and motor failure, plus late quality detection, cost throughput. Commissioning on real hardware is
   slow and risky.
3. **What is a digital twin?** Digital model vs. digital shadow vs. digital twin (data flow direction
   diagram). Our project sits at "twin": bidirectional and model-based.
4. **Objectives.** G1–G7 from the design doc as a one-line list.
5. **Reference plant.** Layout drawing of the 1.2 m conveyor with stations and tag table (M-001, ENC-001,
   PE-101…401, CAM-201, YV-301, HL-001, ES-001).
6. **System architecture.** Three-layer diagram: virtual plant → twin service → HMI, mapped to ISA-95
   levels 0–3.
7. **Virtual commissioning concept.** Why simulate the plant, and how the twin is protocol-only so a real PLC
   can drop in.
8. **Plant physics model.** DC motor equations, belt kinematics, thermal model, step-response plot.
9. **Control logic.** PackML state diagram, interlocks, encoder-based reject tracking (shift register).
10. **Industrial communication.** OPC UA address space (ISA-95 tree) and MQTT Unified Namespace topic tree,
    with why each one is used.
11. **Twin model and residuals.** Predicted vs. actual arrival, slip and current residuals; table of fault
    signatures.
12. **Vision inspection.** Virtual camera → OpenCV pipeline (ROI, HSV, contour, verdict) → reject;
    example frames.
13. **Analytics.** OEE formula with live example, shift report, predictive health and time-to-alarm.
14. **What-if simulation.** Faster-than-real-time run and comparison chart of two speed setpoints.
15. **HMI design.** ISA-101 high-performance HMI principles with a screenshot of the twin.
16. **Results.** Latency, detection time for each fault, OEE before/after what-if, test coverage.
17. **Limitations and future scope.** Real hardware on Jetson Nano edge, ML anomaly detection, cloud
    historian, Sparkplug B, multi-line plant.
18. **Live demo**, then **Q&A.**

Slide visuals to produce from the finished project: architecture diagram, plant layout, PackML diagram,
motor step response, residual plot during a slip fault, HMI screenshots (overview, alarms, OEE, what-if).
