# TeleWard (`teleward`)

## Problem
Over two million nursing students, paramedics, telemetry technicians, and medical residents take mandatory hospital dysrhythmia exams and AHA ACLS certification each year. Trainees use 20-year-old static web quizzes ([Harvard ECG Wave-Maven](https://ecg.bidmc.harvard.edu/), [SkillStat 6-Second ECG](https://www.skillstat.com/tools/ecg-simulator/), and [ABG Ninja](https://abg.ninja/)). Commercial 3D simulator apps such as [Full Code Medical Simulation](https://fullcodemedical.com/) charge \$120 per institutional seat. Static JPEG strips do not teach multi-bed telemetry scanning, 12-lead caliper measurement, or real-time physiological outcomes after drug or shock errors.

## User group
Nursing students, paramedics, emergency nurses, and medical trainees on [r/StudentNurse](https://www.reddit.com/r/StudentNurse/), [r/medicalschool](https://www.reddit.com/r/medicalschool/), and [r/emergencymedicine](https://www.reddit.com/r/emergencymedicine/) who prepare for AHA ACLS MegaCode and hospital telemetry exams.

## MVP
1. **PhysioNet `PTB-XL` Binary Waveform Compiler & CLI (`npx teleward`)**: Python, DuckDB, and TypeScript pipeline that compiles 120 cardiologist-annotated 12-lead ECG records from [PhysioNet PTB-XL](https://physionet.org/content/ptb-xl/1.0.3/) (CC-BY 4.0) into `Float32` binary chunks. Each chunk includes SCP-ECG diagnostic ground truth and beat fiducial markers.
2. **Deterministic Coupled Cardiopulmonary & ACLS State Engine**: Seeded (`--seed`) TypeScript state machine and ODE solver that computes live ECG rhythms, arterial blood pressure (`ABP`), pulse oximetry (`SpO2`), and capnography (`EtCO2`). Vitals respond deterministically to eight ACLS interventions (`Adenosine 6mg`, `Amiodarone 300mg`, `Epinephrine 1mg`, `Atropine 1mg`, `Magnesium Sulfate 2g`, `Synchronized Cardioversion`, `Defibrillation`, and `Transcutaneous Pacing`).
3. **60fps Browser ICU Telemetry Game & Self-Serve Pro Exam/Cohort Tier**: Zero-login 4-bed ICU telemetry shift game (`/shift`), daily seeded 60-second challenge (`/daily`), and interactive 12-lead calipers (`/caliper/<case-id>`). Includes a Stripe Checkout gate (\$19 one-time ACLS/NCLEX Telemetry Exam Pass and \$49/month stateless `?cohort=<seed>` Instructor mode).

## Visible surface
**Category**: Real-time clinical simulation game + signal-processing CLI (`game-simulation` + `data-pipeline` + `cli-library`).
- **Web routes `/shift`, `/daily`, and `/caliper/<case-id>`**: 60fps 2D Canvas 4-bed ICU Central Telemetry Station with WebAudio `IEC 60601-1-8` hospital alarms. A visitor clicks any active bed, places two-point digital calipers across the 12-lead strip (`ms` and `mV`), and triggers an ACLS drug or shock before the countdown ends. The waveform converts to sinus rhythm or degrades into arrest, and the screen prints an **ACLS Causal Timeline & Hemodynamic Receipt**.
- **CLI command**: `npx teleward sim --scenario torsades --intervention amiodarone_300mg --seed 42 --json` executes a headless physiological trajectory and prints beat-by-beat vital transitions and AHA rule violations without credentials.

## Stack
- **Signal Compiler & CLI**: Python 3.12 (`wfdb`, `numpy`, DuckDB) for `PTB-XL` binary chunk export; TypeScript + Node.js CLI (`npx teleward`) + `vitest` physiological invariant suite.
- **Simulation & Audio Engine**: Pure TypeScript seeded PRNG + fourth-order Runge-Kutta (`RK4`) hemodynamic ODE solver + WebAudio API `IEC 60601-1-8` alarm synthesizer (`0` external audio files).
- **Web Workbench & Billing**: Preact, TypeScript, Vite, Tailwind CSS, 60fps HTML5 2D Canvas phosphor-sweep ring buffer, Stripe Checkout payment links (\$0/month static hosting on Vercel).

## Milestones
- **Week 1 — `PTB-XL` 120-Strip Compiler & Seeded ACLS Physiology Engine**: Compile 120 curated `PTB-XL` 500Hz 12-lead records into `Float32` binary chunks (10 per core AHA ACLS and STEMI class). Build the deterministic ACLS state machine (`12` rhythms, `8` interventions, and fatal mistreatment transitions) and `npx teleward sim` CLI with `vitest` invariant tests.
- **Week 2 — 60fps Telemetry Canvas, `IEC 60601-1-8` Alarms & 12-Lead Calipers**: Build the 60fps 2D Canvas phosphor-sweep ring buffer, WebAudio hospital alarm synthesizer, and `/caliper/<case-id>` two-point caliper tool (`PR`, `QRS`, `QTc` in `ms` and `ST` elevation in `mV` against `PTB-XL` annotations).
- **Week 3 — Playable 4-Bed `/shift` Game, `/daily` Seeded Mode & Debrief Receipt**: Ship the 60-second 4-bed telemetry crisis game loop, post-code causal hemodynamic timeline receipt, and shareable `/daily` score card. Pass `impeccable/scripts/detect.mjs` with `0` findings.
- **Week 4 — Stripe Exam Pass, Stateless `?cohort=<seed>` Instructor Mode & Launch**: Wire the \$19 ACLS Exam Pass and stateless `?cohort=<seed>` classroom challenge generator. Record a 45-second GIF of a live `Torsades` arrest conversion and launch `teleward.tomnguyen.me`.

## Launch surface
1. [r/StudentNurse](https://www.reddit.com/r/StudentNurse/) and [r/nursing](https://www.reddit.com/r/nursing/) — post the free `/daily` 60-second ICU Telemetry Shift & ACLS MegaCode trainer as a 12-lead upgrade to `SkillStat`.
2. [r/medicalschool](https://www.reddit.com/r/medicalschool/), [r/emergencymedicine](https://www.reddit.com/r/emergencymedicine/), and [r/Paramedics](https://www.reddit.com/r/Paramedics/) — post the interactive `PTB-XL` 12-lead caliper tool and closed-loop ACLS drug/shock simulator.
3. Show HN (`news.ycombinator.com/submit`) — *"Show HN: TeleWard – 60fps browser ICU telemetry and ACLS simulator built on 21k PhysioNet PTB-XL ECGs"*.

## Validation
- **Demand evidence**: Trainees on [r/StudentNurse](https://www.reddit.com/r/StudentNurse/) and [r/medicalschool](https://www.reddit.com/r/medicalschool/) recommend [SkillStat ECG Simulator](https://www.skillstat.com/tools/ecg-simulator/), [ABG Ninja](https://abg.ninja/), and [Harvard ECG Wave-Maven](https://ecg.bidmc.harvard.edu/) every week for ACLS and telemetry exam preparation, while [Full Code](https://fullcodemedical.com/) charges \$120 per institutional seat.
- **Closest existing tools**:
  1. [SkillStat 6-Second ECG](https://www.skillstat.com/tools/ecg-simulator/) — synthetic 1-lead strips only; lacks 12-lead calipers, hemodynamic waveforms, and closed-loop drug or shock physics.
  2. [Harvard ECG Wave-Maven](https://ecg.bidmc.harvard.edu/) — static 2003 JPEG quiz bank; lacks live sweeping telemetry and timed ACLS interventions.
  3. [ResusMonitor](https://resusmonitor.com/) / [SimCore](https://simcore.app/) — passive two-device display monitors that require an instructor to type vitals on a second screen; lacks an autonomous physiology engine and solo game loop.
- **Wedge**: First open-source, zero-login browser ICU telemetry game that combines real [PhysioNet PTB-XL](https://physionet.org/content/ptb-xl/1.0.3/) 12-lead waveforms, two-point digital calipers, and a deterministic ACLS drug and defibrillation physics engine at `<$20` self-serve pricing.

## Success metric
Within 30 days of launch: **>= 500** completed `/daily` or `/shift` telemetry game sessions, **>= 25** GitHub stars or clinical educator issues on nursing and EM forums, and **>= 5** self-serve Stripe Checkout purchases (\$19 ACLS Exam Pass or \$49 Instructor Cohort pack).

## Decision: extend or greenfield
**Greenfield repo (`teleward`)**. Existing healthcare repositories ([overturn](file:///C:/Users/huuth/Desktop/overturn/README.md), [practicegate](file:///C:/Users/huuth/Desktop/practicegate/README.md), and [omnitriage](file:///C:/Users/huuth/Desktop/omnitriage/README.md)) handle clinical administration and billing CRUD workflows, while [Maze-v2](file:///C:/Users/huuth/Desktop/Maze-v2) is a maze game. `teleward` combines clinical domain expertise and deterministic Canvas loop architecture into a standalone biomedical signal-processing and simulation product with zero overlap with your employer's clinic portal.

## Enterprise upgrade
**Multi-Bed Instructor WebRTC SimLab & SCORM/LTI Nursing LMS Gradebook Export**: Add live instructor WebRTC vitals override (`Code Blue` curveballs mid-shift), automated AHA ACLS rubric PDF certificates, and Canvas/Blackboard LTI 1.3 gradebook sync for nursing schools and EMS academies.

## Kickoff prompt
```text
Read C:\Users\huuth\Desktop\teleward\PROJECT_PLAN.md and run /grill-with-docs to start the feature pipeline for TeleWard (teleward). Build the Python + DuckDB compiler for 120 curated PhysioNet PTB-XL 12-lead ECG records into Float32 binary chunks, the deterministic seeded TypeScript ACLS cardiopulmonary state engine (`npx teleward sim`), the 60fps 2D Canvas 4-bed ICU telemetry station with WebAudio IEC 60601-1-8 alarms and 12-lead marching calipers (`/shift`, `/daily`, `/caliper/<case-id>`), and the Stripe Checkout Pro Exam Pass + stateless `?cohort=<seed>` instructor mode.
```
