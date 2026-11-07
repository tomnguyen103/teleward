---
status: accepted
---

# 0001 — Packed Little-Endian Float32 Binary Chunks and Client-Side Seeded RK4 ODE Engine

TeleWard compiles 120 curated PhysioNet `PTB-XL` 500 Hz 12-lead ECG records into a single packed little-endian `Float32` binary asset (`public/data/ptbxl_120.bin` + `public/data/ptbxl_index.json`) and executes the coupled cardiopulmonary 4th-order Runge-Kutta (`RK4`) ODE solver and 2D Canvas ring buffer directly in the browser and Node CLI (`npx teleward sim`), rather than streaming telemetry over WebSockets from a stateful backend server.

## Counter-Argument (Substituted by Isolated Subagent `ADR Counter-Argument`)

Engine 2 Codex was substituted by a fresh isolated subagent (`Role: "ADR Counter-Argument"`), which argued:
1. **Multi-Clinician Split-Brain**: Client-side RK4 integration couples physiological progression to browser tab timers (`requestAnimationFrame` throttling and background tab sleep), so two clinicians viewing the same bed see divergent waveforms and arrhythmia onsets.
2. **Broken Alarm & Audit Authority**: Clinical telemetry requires server-authoritative alarm escalation and an immutable server audit trail; closing a browser tab silences alarms and loses patient hemodynamics.
3. **Initial Payload Bottleneck**: Preloading 120 12-lead 10-second PTB-XL records (`120 × 12 × 5000 × 4B ≈ 28.8 MB`) penalizes Time-to-Interactive compared to WebSocket streaming (`~24 KB/s`).
4. **Architectural Dishonesty**: Replacing distributed stream ingestion with a local canvas animation loop omits real tele-ICU backpressure engineering.

## Why the Counter-Argument Lost

1. **Product Domain is Zero-Login Training & Exam Simulation, Not Hospital EHR Monitoring**: TeleWard targets solo nursing/medical trainees and classroom cohorts at `$0/month` static hosting (`PROJECT_PLAN.md` §Stack), where server-side WebSocket state would introduce hosting costs, cold-start latency, and offline CLI failures (`npx teleward sim` must run headlessly without credentials or network).
2. **Deterministic Integer-Tick RK4 Eliminates Split-Brain**: By decoupling physiological RK4 integration (`dt = 0.05s` indexed by integer tick `k`) from `requestAnimationFrame` wall-clock jitter and seeding the Mulberry32 PRNG via `fnv1a32(cohortSeed)`, every student opening `?cohort=NURS402` and every CLI invocation with `--seed 42` computes bit-identical vital trajectories.
3. **2.5-Second Seamless Tile Compression Solves Payload Size**: Each compiled record stores a phase-aligned `2.5s` (`1250`-sample at `500 Hz`) multi-beat 12-lead tile (`120 × 12 × 1250 × 4 + 32 = 7,200,032` bytes = `6.87 MB` raw, `< 1.8 MB` compressed) that expands seamlessly to `10s` (`5000` samples) in `< 15 ms` on load.

Wrong if: `public/data/ptbxl_120.bin` exceeds `7,500,000` bytes (`7.5 MB`) or `loadPtbxlBinary()` takes `>= 50 ms` to parse and verify CRC32 across all 120 records — checked by `tests/compiler-and-loader.test.ts`.
