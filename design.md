---
name: TeleWard Obsidian Clinical Telemetry & Caliper System
stitch-project: "5346407181046115572"
stitch-screen: "projects/5346407181046115572/screens/a239acb4a4c440c6bfad057d829ad3ab"
stitch-design-system: "assets/0a2888c1d93b47d98f90481e79637393"
archetype:
  shift: monitoring
  daily: monitoring
  caliper: editor
  cohort: settings-admin
scope-sidebar: dark
default-theme: dark
---

# TeleWard (`teleward`) — Design System (`design.md`)

## 1. Visual Direction & Domain Scene
TeleWard is a high-density ICU Central Telemetry Station and 12-lead ECG Caliper Workbench built for nursing students, paramedics, emergency medicine residents, and ACLS instructors. Modeled after Philips IntelliVue MX800, GE CARESCAPE B850, and Nihon Kohden bedside hardware with Notion's calm 2-region structural discipline, the workstation defaults to the **Obsidian ICU Cockpit (`[data-theme="dark"]`)** (`--bg: #070A0E`, `--surface: #0C1117`, `--surface-muted: #121922`, `--canvas-well: #04070A`, `--border: #1E2936`, `--primary: #10B981` clinical emerald, `--accent-cyan: #0EA5E9` diagnostic cyan) to preserve dark-adaptation across 12-hour ICU shifts. A warm archival ECG paper daylight theme (`[data-theme="light"]`, `--bg: #F4F3EF`, `--surface: #FCFBF9`, `--caliper-paper: #FFFDF9`, `--primary: #0F766E`) is available via the top-bar theme toggle. Generic SaaS indigo (`#4338CA`, `#818CF8`) is strictly prohibited across all surfaces.

## 2. Archetype & Calm 2-Region Shell Mapping (`app-ui-shell` & `30-ui.md`)
- **Top-Level Functional Areas (4 routes in Top Bar and Left Rail)**:
  1. `/shift` — **Shift Ward** (`monitoring`)
  2. `/daily` — **Daily Seed** (`monitoring`)
  3. `/caliper/:caseId` — **Calipers** (`editor`)
  4. `/cohort` — **Cohort Pro** (`settings-admin`)
- **Unified Single 64px Sticky Top Bar (Zero Double-Stacked Top Banners)**:
  - **Left**: Rail collapse/drawer toggle + brand mark (`TeleWard`) + station unit tag (`ICU-4A // 500Hz`) + horizontal route navigation (`Shift Ward`, `Daily Seed`, `Calipers`, `Cohort Pro`).
  - **Center**: Quick Case & Rhythm Filter (`Ctrl+K` / `/`) + inline IEC 60601-1-8 priority beacon & audio module (`data-testid="audio-arm-banner"`) + `120s` alarm silence countdown toggle + active `?cohort=` seed pill.
  - **Right Contiguous Action Cluster (`>= 40px` square icon buttons, `8px` gap, zero text/chips between icons)**: `[Audio/IEC Alarm Mute Toggle]` `[Theme Toggle]` `[Causal Log Drawer Toggle]` `[Cohort Settings]`.
- **Calm 2-Region Default Shell (`Left Rail` + `Main Canvas` at rest)**:
  - **Region 1 — Left Scope Rail (`240px` expanded, `56px` collapsed on desktop, full `240px` slide-over drawer `<768px`, dark `#05080C`)**: Holds the 4 Workbench route tabs (reachable at every viewport), active Ward Beds (`Bed 01`..`Bed 04` with live HR and rhythm badge), and the `PTB-XL` 12-rhythm bank (`NSR`..`STEMI_ANT` with full 120-record dataset counts).
  - **Region 2 — Focused Main Canvas (`1fr`, fluid ceiling, `<= 3` component groups per tab)**:
    - `/shift`: Header strip (`<h1>Central Telemetry Shift</h1>`), 2×2 HiDPI (`devicePixelRatio`) 2D Canvas ICU Bed Matrix, and segmented **2-Bay ACLS Crash Cart Dock** (**Electrical Therapy Bay** + **ISO-26825 IV Pharmacology Bolus Rack**, hotkeys `1`–`8`).
    - `/daily`: Header strip (`<h1>Daily Telemetry Challenge</h1>`) with segmented switch (`Live Ward` | `Standings`), single-heading embedded ward station, and 4-column leaderboard.
    - `/caliper/:caseId`: Header strip (`<h1>Diagnostic Strip Calipers</h1>`) with `25/50 mm/s` speed and `5/10/20 mm/mV` gain selectors, 500 Hz 12-lead ECG millimeter grid with direct pointer hit-testing on `T1/T2/V1/V2`, and compact interval grading bar.
    - `/cohort`: Header strip (`<h1>Cohort Roster and Access</h1>`) with 3-way segmented control (`Cohort Roster` | `Receipt Verifier` | `Pro Access`).
- **On-Demand Causal Peek Drawer (`360px` slide-over sheet, `data-testid="causal-timeline-inspector"`)**:
  - Stays mounted in the DOM for instant inspection and test accessibility while sliding over on demand when toggled via the top-bar `Causal Log` button. Holds the **ACLS Causal Timeline & Hemodynamic Receipt** and **PTB-XL Cardiologist Fiducial Ground Truth**.

## 3. Typography (`30-ui.md` & `impeccable` Craft Floor)
- **Display & UI Sans (`--font-sans`)**: `'Instrument Sans', 'Segoe UI', system-ui, sans-serif` (banned default hero faces like Inter, Roboto, Space Grotesk, Plus Jakarta Sans, Geist are excluded).
- **Data, Vitals & Caliper Monospace (`--font-mono`)**: `'IBM Plex Mono', ui-monospace, monospace` — restricted strictly to ECG intervals (`ms`, `mV`), physiological vital readouts (`HR`, `ABP`, `SpO2`, `EtCO2`, `RR`), `PTB-XL` case IDs, and `TW-...` receipt codes. Never used on navigation labels, buttons, or headings.
- **Scale & Hierarchy (`>= 1.25x` separation, `font-style: normal` on all headings)**:
  - Page heading (`h1`): `1.5rem` (`24px`), `font-weight: 600`, `letter-spacing: -0.02em`, `line-height: 1.3`.
  - Pane / Bed title (`h2`): `1.125rem` (`18px`), `font-weight: 600`, `line-height: 1.35`.
  - Body copy: `1rem` (`16px`), `line-height: 1.6`, measure `65–72ch`.
  - Functional UI controls, chips & metadata: `0.875rem` (`14px`), `line-height: 1.4`.
  - Vital readout numerals: `1.75rem` (`28px`), `font-weight: 600`, `font-variant-numeric: tabular-nums`.

## 4. Three-Layer Color & Surface Tokens

### Layer 1 & 2 — Adaptive Shell & Surface Tokens (WCAG AAA Checked)
| Token | Dark Theme (Default Obsidian ICU Cockpit) | Light Theme (Archival ECG Daylight) | Usage |
| :--- | :--- | :--- | :--- |
| `--bg` | `#070A0E` | `#F4F3EF` | Application background |
| `--surface` | `#0C1117` | `#FCFBF9` | Instrument panels, bed bays, inspector, crash cart dock |
| `--surface-muted` | `#121922` | `#EBE9E2` | Hover states, recessed controls, table headers |
| `--canvas-well` | `#04070A` | `#060A0F` | 2D Canvas telemetry monitor well (warm carbon, never `#000000`) |
| `--caliper-paper` | `#0A0F16` | `#FFFDF9` | 12-lead ECG millimeter calibration grid background |
| `--border` | `#1E2936` | `#D5D1C8` | `1px` structural hairlines |
| `--text` | `#ECF2F8` | `#111820` | Primary headings and body copy |
| `--text-muted` | `#94A6B8` | `#4A5562` | Hue-tinted secondary metadata (never pure gray) |
| `--primary` | `#10B981` | `#0F766E` | Clinical emerald primary interactive action & focus ring |
| `--on-primary` | `#04130D` | `#FFFFFF` | Text on `--primary` |
| `--accent-cyan` | `#0EA5E9` | `#0369A1` | Diagnostic caliper & telemetry accent |
| `--sidebar-bg` | `#05080C` | `#0B1017` | Dark Scope Sidebar background |
| `--sidebar-text` | `#E2E8F0` | `#E2E8F0` | Scope Sidebar primary label |
| `--sidebar-muted` | `#8CA0B5` | `#94A3B8` | Scope Sidebar secondary count |
| `--sidebar-active-bg` | `#111A24` | `#16202C` | Active scope row fill |
| `--sidebar-active-edge`| `#10B981` | `#10B981` | Active scope indicator |

### Layer 3 — Physiological Trace, ISO 26825 Drug & IEC 60601-1-8 Alarm Tokens
| Token | Value | Usage |
| :--- | :--- | :--- |
| `--trace-ecg` | `#00E676` | Lead II / V1 ECG waveform (`1 mV` calibrated) & HR numeral (`bpm`) |
| `--trace-abp` | `#FF5252` | Invasive Arterial Blood Pressure (`ABP`) waveform & `SBP/DBP (MAP)` (`mmHg`) |
| `--trace-spo2` | `#00E5FF` | Pulse Oximetry (`SpO2`) plethysmograph & `%` numeral |
| `--trace-etco2` | `#FFD740` | Capnography (`EtCO2`) waveform & `mmHg` numeral |
| `--ecg-grid-minor` | `rgba(225, 29, 72, 0.14)` | `1 mm` (`40 ms` × `0.1 mV` at standard speed/gain) ECG paper minor grid |
| `--ecg-grid-major` | `rgba(225, 29, 72, 0.32)` | `5 mm` (`200 ms` × `0.5 mV` at standard speed/gain) ECG paper major grid |
| `--alarm-crisis-bg` / `--alarm-crisis-text` | `#3B0A11` / `#FECDD3` | High Priority IEC 60601-1-8 Crisis state (`VFIB`, `VT_MONO`, `TORSADES`, `ASYSTOLE`, `PEA`) |
| `--alarm-warn-bg` / `--alarm-warn-text` | `#3B2106` / `#FDE68A` | Medium Priority IEC 60601-1-8 Warning state (`SVT`, `AFIB`, `AFLT`, `AVB3`, `SB`, `STEMI_ANT`) |
| `--alarm-normal-bg` / `--alarm-normal-text` | `#052E1C` / `#A7F3D0` | Normal perfusing sinus state (`NSR`) |

## 5. Mechanical Craft Floor & Anti-Slop Bans
- **Zero Eyebrows/Kickers**: Never place uppercase tracked text or pill badges above `h1`/`h2`/`h3` headings.
- **Zero Arbitrary Numbering**: Never prefix sections with `01 / 02 / 03`.
- **Zero Identical Card Grids or Nested Cards**: Never place cards inside cards (`border` + `bg` inside `border` + `bg`). Use `1px` hairlines (`divide-y`, `border-b`) for internal grouping.
- **Zero Glow Halos or 1-Sided Thick Borders**: No `box-shadow` neon halos and no `border-left: 4px`.
- **Zero Fake Visuals**: No pulsing CSS status dots on static elements; all motion lives in the 60fps 2D Canvas phosphor sweep and exponential ease-out (`cubic-bezier(0.22, 1, 0.36, 1)`) drawer transitions.
- **Browser Surfaces**: Customize `::selection`, `caret-color`, custom scrollbars, focus rings, and enforce `font-variant-numeric: tabular-nums` on every vital, timer, and caliper value.
