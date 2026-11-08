# TeleWard (`teleward`)

TeleWard is a real-time ICU central telemetry station, 12-lead ECG caliper workbench, deterministic AHA ACLS cardiopulmonary simulation engine, and classroom cohort verification service built on curated PhysioNet PTB-XL records.

## Language

### Signal & Electrocardiography

**PTB-XL Record**:
A cardiologist-annotated 500 Hz, 12-lead electrocardiogram record from the PhysioNet PTB-XL dataset (`ptbxl-001` through `ptbxl-120`) compiled into calibrated millivolts (`mV`).
_Avoid_: Strip image, mock waveform, audio wave

**Binary Waveform Chunk (`TWEC`)**:
The packed little-endian `Float32` binary file (`ptbxl_120.bin`) containing a 32-byte `TWEC` header, CRC32 checksum, and contiguous lead-major `I, II, III, aVR, aVL, aVF, V1..V6` sample blocks.
_Avoid_: JSON dump, CSV export, raw ADC buffer

**Fiducial Ground Truth**:
The cardiologist-validated onset, peak, and offset markers (`P_on`, `QRS_on`, `R_peak`, `QRS_off`, `T_off`, `J_point`) and derived intervals (`PR`, `QRS`, `QT`, Bazett `QTc` in `ms`, and `ST` deviation in `mV`) for a PTB-XL Record.
_Avoid_: Approximate guess, pixel offset

**Digital Calipers**:
A two-point interactive measurement tool with direct pointer hit-testing on vertical time hairlines (`T1`, `T2` in `ms`), marching R-R spikes, and horizontal amplitude hairlines (`V1`, `V2` in `mV`) calibrated to standard ECG paper (`25 mm/s` or `50 mm/s`, `5 / 10 / 20 mm/mV`).
_Avoid_: Ruler, cursor box

### Cardiopulmonary Physiology & ACLS

**Rhythm Class**:
One of the 12 canonical cardiac electrical states in TeleWard: `NSR`, `SB`, `SVT`, `AFIB`, `AFLT`, `AVB3`, `VT_MONO`, `TORSADES`, `VFIB`, `ASYSTOLE`, `PEA`, or `STEMI_ANT`.
_Avoid_: Disease type, heartbeat mode

**Coupled Hemodynamic State**:
The continuous physiological vector (`HR`, arterial `SBP`/`DBP`/`MAP`, `SpO2`, `EtCO2`, `RR`) integrated via 4th-order Runge-Kutta (`RK4`) where mechanical perfusion depends on the active Rhythm Class and vascular tone.
_Avoid_: Static vitals, random numbers

**ACLS Intervention**:
One of the eight clinical resuscitation actions grouped into the **Electrical Therapy Bay** (`sync_cardioversion`, `defibrillation`, `transcutaneous_pacing`) and the **ISO-26825 IV Pharmacology Bolus Rack** (`adenosine_6mg`, `amiodarone_300mg`, `epinephrine_1mg`, `atropine_1mg`, `magnesium_2g`) applied to a patient bed.
_Avoid_: Power-up, spell, button click

**AHA Rule Violation**:
A deterministic clinical error logged when an operator applies a contraindicated ACLS Intervention (such as unsynchronized defibrillation on a perfusing rhythm or Asystole, or amiodarone in polymorphic Torsades de Pointes).
_Avoid_: Game penalty, syntax error

**Causal Timeline & Hemodynamic Receipt**:
The post-intervention audit log recording timestamped interventions, pre- and post-treatment Coupled Hemodynamic States, rhythm conversions, and any AHA Rule Violations.
_Avoid_: Score popup, chat log

### Telemetry Station, Cohort Mode & REST API

**Phosphor-Sweep Ring Buffer**:
A fixed-length `Float32Array` circular buffer with continuous cardiac phase integration rendered at 60fps on HiDPI (`devicePixelRatio`) HTML5 2D Canvas with a moving write cursor, a `1 mV` calibration step pulse, and a `180 ms` blanking erase bar ahead of the active trace head.
_Avoid_: Scrolling chart, SVG polyline

**IEC 60601-1-8 Alarm Burst**:
A WebAudio-synthesized medical alarm sequence conforming to IEC 60601-1-8 priority envelopes (10-pulse High Priority crisis burst `C4-E4-G4-B4-C5` and 3-pulse Medium Priority warning burst `C4-E4-G4`).
_Avoid_: Sound effect, alert chime

**Cohort Seed (`?cohort=<seed>`)**:
An alphanumeric classroom identifier hashed via `fnv1a32` to synchronize 4-bed deterioration sequences, caliper cases, and server-persisted cohort rosters across all students in an instructor's session.
_Avoid_: Room ID, database session

**Cohort Verification Receipt (`TW-<COHORT>-<SCORE>-<CRC16>`)**:
A tamper-evident completion code signed with CRC16 over the Cohort Seed, score, stabilized bed count, and AHA Rule Violations, verifiable both offline and via `POST /api/receipts/verify`.
_Avoid_: Unverified screenshot, leaderboard row

**Cohort Roster Ledger**:
The server-persisted classroom submission table (`/api/cohorts/:seed/submissions`, backed by `.teleward-data/store.json`) recording student alias, score, stabilized bed count, AHA Rule Violations, and verified `TW-...` receipt code.
_Avoid_: Chat room, unverified form
