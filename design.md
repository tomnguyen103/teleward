---
name: TeleWard Clinical Telemetry & Caliper System
stitch-project: "5346407181046115572"
archetype:
  shift: monitoring
  daily: monitoring
  caliper: editor
  cohort: settings-admin
scope-sidebar: dark
---

# TeleWard (`teleward`) — Design System (`design.md`)

## 1. Visual Direction & Domain Scene
TeleWard is an ICU Central Telemetry Station and 12-lead ECG Caliper Workbench built for nursing students, paramedics, and medical residents preparing for AHA ACLS MegaCode and hospital dysrhythmia certification. It blends the `Slate & Indigo Professional` application shell (`app-ui-shell/references/default-theme.md`) with high-contrast bedside patient monitor wells (`#0B0F17` warm-tinted deep carbon obsidian, never pure `#000000`) and standard clinical waveform trace semantics (`ECG` phosphor emerald, `ABP` arterial crimson, `SpO2` plethysmograph cyan, `EtCO2` capnography amber).

## 2. Archetype & Pane Mapping (`app-ui-shell`)
- **Top-Level Functional Areas (4 routes -> Horizontal Nav in Single 64px Sticky Top Bar)**:
  1. `/shift` — **4-Bed ICU Shift** (`monitoring`)
  2. `/daily` — **Daily Code** (`monitoring`)
  3. `/caliper/:caseId` — **12-Lead Calipers** (`editor`)
  4. `/cohort` — **Cohort & Exam Pass** (`settings-admin`)
- **Single 64px Sticky Top Bar**:
  - **Left**: Brand mark (`TeleWard`) + horizontal route navigation (active item carries both color shift and `2px` bottom underline indicator).
  - **Center**: Quick Case & Rhythm Filter (`Ctrl+K` / `/`).
  - **Right Contiguous Action Cluster (`>= 40px` square icon buttons, `8px` gap, zero text/chips between icons)**: `[Audio/IEC Alarm Mute Toggle]` `[Theme Toggle]` `[Operator Avatar Dropdown]`.
- **Scope Sidebar (`240px` at `xl+`, `56px` rail at `md/lg`, off-canvas drawer `<768px`, dark `#0F172A`)**:
  - Holds active ICU Bed scopes (`Bed 01`..`Bed 04` with live rhythm & alarm priority badges) and the `PTB-XL` 12-rhythm diagnostic filter scopes (`NSR`, `SB`, `SVT`, `AFIB`, `AFLT`, `AVB3`, `VT_MONO`, `TORSADES`, `VFIB`, `ASYSTOLE`, `PEA`, `STEMI_ANT`).
- **Main Pane (`w-full flex-1`, fluid ceiling)**:
  - `/shift` & `/daily`: Station header (active scenario, countdown clock, shift reset) + 2×2 60fps 2D Canvas ICU Bed Grid + bottom **ACLS Crash Cart Dock** (`8` interventions with explicit acting-as target bed guard: `"Administer to Bed 02 (SVT)"`).
  - `/caliper/:caseId`: 12-lead ECG calibrated paper grid (`25 mm/s`, `10 mm/mV`) with interactive `T1`/`T2` (`ms`) and `V1`/`V2` (`mV`) caliper handles, marching R-R hairlines, and interval grading toolbar.
- **Docked Inspector (`360px` at `2xl`, `320px` at `xl`, drawer `<1280px`)**:
  - Holds the **ACLS Causal Timeline & Hemodynamic Receipt** (beat-by-beat vital trajectory, pre/post intervention delta, AHA rule violation rationale) on `/shift` & `/daily`, and the **PTB-XL Cardiologist Fiducial Ground Truth & Bazett QTc Grading Ledger** on `/caliper/:caseId`.

## 3. Typography (`30-ui.md` & `impeccable` Craft Floor)
- **Display & UI Sans (`--font-sans`)**: `'Instrument Sans', 'Segoe UI', system-ui, sans-serif` (banned default hero faces like Inter, Roboto, Space Grotesk, Plus Jakarta Sans are excluded).
- **Data, Vitals & Caliper Monospace (`--font-mono`)**: `'IBM Plex Mono', ui-monospace, monospace` — restricted strictly to ECG intervals (`ms`, `mV`), physiological vital readouts (`HR`, `ABP`, `SpO2`, `EtCO2`), `PTB-XL` case IDs, and `TW-...` receipt codes. Never used on navigation labels, buttons, or headings.
- **Scale & Hierarchy (`>= 1.25x` separation, `font-style: normal` on all headings)**:
  - Page heading (`h1`): `1.5rem` (`24px`), `font-weight: 600`, `letter-spacing: -0.02em`, `line-height: 1.3`.
  - Pane / Bed title (`h2`): `1.125rem` (`18px`), `font-weight: 600`, `line-height: 1.35`.
  - Body copy: `1rem` (`16px`), `line-height: 1.6`, measure `65–72ch`.
  - Functional UI controls, chips & metadata: `0.875rem` (`14px`), `line-height: 1.4`.
  - Vital readout numerals: `1.75rem` (`28px`), `font-weight: 600`, `font-variant-numeric: tabular-nums`.

## 4. Three-Layer Color & Surface Tokens

### Layer 1 & 2 — Adaptive Shell & Surface Tokens (WCAG AAA Checked)
| Token | Light Theme | Dark Theme (Default ICU Station) | Usage |
| :--- | :--- | :--- | :--- |
| `--bg` | `#F8FAFC` | `#060A12` | Application background |
| `--surface` | `#FFFFFF` | `#0F172A` | Panes, cards, inspector, crash cart dock |
| `--surface-muted` | `#F1F5F9` | `#1E293B` | Hover states, inactive tabs, table header |
| `--canvas-well` | `#0B0F17` | `#0B0F17` | 2D Canvas telemetry monitor well (warm carbon, never `#000000`) |
| `--caliper-paper` | `#FFFDF9` | `#111827` | 12-lead ECG millimeter calibration grid background |
| `--border` | `#E2E8F0` | `#334155` | `1px` structural hairlines |
| `--text` | `#0F172A` | `#F1F5F9` | Primary headings and body copy |
| `--text-muted` | `#3F4C63` | `#CBD5E1` | Hue-tinted secondary metadata (never pure gray) |
| `--primary` | `#4338CA` | `#818CF8` | Primary interactive action & focus ring |
| `--on-primary` | `#FFFFFF` | `#060A12` | Text on `--primary` |
| `--sidebar-bg` | `#0F172A` | `#090D16` | Dark Scope Sidebar background |
| `--sidebar-text` | `#E2E8F0` | `#E2E8F0` | Scope Sidebar primary label |
| `--sidebar-muted` | `#A8B4C7` | `#94A3B8` | Scope Sidebar secondary count |
| `--sidebar-active-bg` | `#1E293B` | `#1E293B` | Active scope row fill |
| `--sidebar-active-edge`| `#818CF8` | `#818CF8` | Active scope indicator |

### Layer 3 — Physiological Trace & IEC 60601-1-8 Alarm Tokens
| Token | Value | Usage |
| :--- | :--- | :--- |
| `--trace-ecg` | `#22C55E` | Lead II / V1 ECG waveform & HR numeral (`bpm`) |
| `--trace-abp` | `#F87171` | Invasive Arterial Blood Pressure (`ABP`) waveform & `SBP/DBP (MAP)` (`mmHg`) |
| `--trace-spo2` | `#38BDF8` | Pulse Oximetry (`SpO2`) plethysmograph & `%` numeral |
| `--trace-etco2` | `#FBBF24` | Capnography (`EtCO2`) waveform & `mmHg` numeral |
| `--ecg-grid-minor` | `rgba(225, 29, 72, 0.14)` | `1 mm` (`40 ms` × `0.1 mV`) ECG paper minor grid |
| `--ecg-grid-major` | `rgba(225, 29, 72, 0.32)` | `5 mm` (`200 ms` × `0.5 mV`) ECG paper major grid |
| `--alarm-crisis-bg` / `--alarm-crisis-text` | `#450A0A` / `#FECACA` | High Priority IEC 60601-1-8 Crisis state (`VFIB`, `VT_MONO`, `TORSADES`, `ASYSTOLE`, `PEA`) |
| `--alarm-warn-bg` / `--alarm-warn-text` | `#451A03` / `#FDE68A` | Medium Priority IEC 60601-1-8 Warning state (`SVT`, `AFIB`, `AFLT`, `AVB3`, `SB`, `STEMI_ANT`) |
| `--alarm-normal-bg` / `--alarm-normal-text` | `#052E16` / `#BBF7D0` | Normal perfusing sinus state (`NSR`) |

## 5. Mechanical Craft Floor & Anti-Slop Bans
- **Zero Eyebrows/Kickers**: Never place uppercase tracked text or pill badges above `h1`/`h2`/`h3` headings.
- **Zero Arbitrary Numbering**: Never prefix sections with `01 / 02 / 03`.
- **Zero Identical Card Grids or Nested Cards**: Never place cards inside cards (`border` + `bg` inside `border` + `bg`). Use `1px` hairlines (`divide-y`, `border-b`) for internal grouping.
- **Zero Glow Halos or 1-Sided Thick Borders**: No `box-shadow` neon halos and no `border-left: 4px`.
- **Zero Fake Visuals**: No pulsing CSS status dots on static elements; all motion lives in the 60fps 2D Canvas phosphor sweep and exponential ease-out (`cubic-bezier(0.22, 1, 0.36, 1)`) drawer transitions.
- **Browser Surfaces**: Customize `::selection`, `caret-color`, custom scrollbars, focus rings, and enforce `font-variant-numeric: tabular-nums` on every vital, timer, and caliper value.
