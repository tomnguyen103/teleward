---
archetype: "Multi-Board Canvas & Telemetry Workbench"
theme_id: "teleward-nocturnal-icu-telemetry-v2"
anchor_hue_oklch: "oklch(0.76 0.16 168)"
typography:
  display:
    fontFamily: "Sora"
    fontSize: "24px"
  sans:
    fontFamily: "Source Sans 3, IBM Plex Sans"
    fontSize: "16px"
  mono:
    fontFamily: "JetBrains Mono, IBM Plex Mono"
    fontSize: "12px"
  scale:
    xs: "12px"
    sm: "14px"
    base: "16px"
    lg: "18px"
    xl: "20px"
    2xl: "24px"
    3xl: "28px"
    4xl: "36px"
colors:
  bg: "#070A0E"
  surface: "#0C1117"
  surfaceMuted: "#121922"
  surfaceInteractive: "#18202C"
  canvasWell: "#04070A"
  caliperPaper: "#0A0F16"
  border: "#1E2936"
  borderStrong: "#243042"
  text: "#ECF2F8"
  textMuted: "#94A6B8"
  primary: "#10B981"
  accentClinical: "#00D4AA"
  onPrimary: "#04130D"
  accentCyan: "#0EA5E9"
  sidebarBg: "#05080C"
  sidebarText: "#E2E8F0"
  sidebarMuted: "#8CA0B5"
  sidebarActiveBg: "#111A24"
  traceEcg: "#00E676"
  traceAbp: "#FF5252"
  traceSpo2: "#00E5FF"
  traceSpo2Text: "#3898FF"
  traceEtco2: "#FFD740"
  alarmCrisisBg: "#3B0A11"
  alarmCrisisText: "#FECDD3"
  alarmWarnBg: "#3B2106"
  alarmWarnText: "#FDE68A"
  alarmNormalBg: "#052E1C"
  alarmNormalText: "#A7F3D0"
  lightBg: "#F4F3EF"
  lightSurface: "#FCFBF9"
  lightSurfaceMuted: "#EBE9E2"
  lightCanvasWell: "#060A0F"
  lightCaliperPaper: "#FFFDF9"
  lightBorder: "#D5D1C8"
  lightText: "#111820"
  lightTextMuted: "#4A5562"
  lightPrimary: "#0F766E"
  lightOnPrimary: "#FFFFFF"
  lightAccentCyan: "#0369A1"
  lightSidebarBg: "#0B1017"
  lightSidebarMuted: "#94A3B8"
  lightSidebarActiveBg: "#16202C"
  canvasStrokeLight: "#0F172A"
rounded:
  none: "0px"
  xs: "3px"
  sm: "4px"
  md: "6px"
  lg: "8px"
  full: "9999px"
---

# TeleWard Design System (`design.md` v2.0)

## 1. Visual Direction & Domain Precedent
TeleWard models a commercial nocturnal ICU central telemetry station (`Philips IntelliVue Information Center iX` / `GE CARESCAPE Central Station`) paired with a calibrated 12-lead ECG caliper workbench (` Litfl` / `ECG Wave-Maven`).
- **Default Polarity**: Nocturnal clinical slate (`#070A0E` / `oklch(0.13 0.015 245)`) with a Daylight Charting Sheet toggle (`data-theme="light"`).
- **Calm 2-Region Default Shell**: Render at most 2 regions at rest (compact top navigation bar + primary canvas). Secondary tools (`Code Cart` drawer and `Causal Log` drawer) open on demand via slide-over drawers.

## 2. Bespoke OKLCH & Hex Token System
| Token | Dark Default | Light Mode | Role |
|---|---|---|---|
| `--bg` | `#070A0E` (`oklch(0.13 0.015 245)`) | `#F4F3EF` (`oklch(0.97 0.008 245)`) | App background |
| `--surface` | `#0C1117` (`oklch(0.17 0.018 245)`) | `#FCFBF9` (`oklch(1.00 0.000 0)`) | Bed tile, top bar, drawer surface |
| `--surface-muted` | `#121922` (`oklch(0.21 0.020 245)`) | `#EBE9E2` (`oklch(0.93 0.012 245)`) | Secondary controls and inputs |
| `--canvas-well` | `#04070A` (`oklch(0.10 0.012 245)`) | `#060A0F` (`oklch(0.12 0.015 245)`) | Recessed 60fps waveform canvas well |
| `--caliper-paper` | `#0A0F16` | `#FFFDF9` | 12-lead ECG millimeter grid surface |
| `--border` | `#1E2936` (`oklch(0.25 0.020 245)`) | `#D5D1C8` (`oklch(0.86 0.014 245)`) | `1px solid` structural hairlines |
| `--text` | `#ECF2F8` (`oklch(0.95 0.010 245)`) | `#111820` (`oklch(0.18 0.020 245)`) | Primary UI copy |
| `--text-muted` | `#94A6B8` (`oklch(0.72 0.022 245)`) | `#4A5562` (`oklch(0.42 0.022 245)`) | Secondary metadata (WCAG AAA) |
| `--primary` | `#10B981` (`oklch(0.76 0.16 168)`) | `#0F766E` (`oklch(0.52 0.14 168)`) | Interactive focus ring & primary CTA |
| `--trace-ecg` | `#00E676` (`oklch(0.80 0.20 148)`) | `#0F766E` | Lead II ECG trace & HR numeric |
| `--trace-abp` | `#FF5252` (`oklch(0.64 0.23 22)`) | `#FF5252` | Arterial blood pressure (`ABP`) & crisis alarm |
| `--trace-spo2` | `#00E5FF` (`oklch(0.76 0.14 215)`) | `#0369A1` | Plethysmograph (`SpO2`) trace |
| `--trace-etco2` | `#FFD740` (`oklch(0.84 0.16 84)`) | `#FFD740` | Capnography (`EtCO2`) trace & warning alarm |

## 3. Typography & Scale (`Sora` + `Source Sans 3` + `JetBrains Mono`)
- `--font-display`: `'Sora', 'IBM Plex Sans', sans-serif` — Section headers and bed identifiers (`font-weight: 600`, roman only, tracking `-0.02em`).
- `--font-sans`: `'Source Sans 3', 'IBM Plex Sans', system-ui, sans-serif` — Clinical controls, tables, and drawers (`16px` body, `1.55` line-height).
- `--font-mono`: `'JetBrains Mono', 'IBM Plex Mono', monospace` — Vital numerics, caliper deltas, countdown timers, and `TW-*` receipts (`font-variant-numeric: tabular-nums`).

## 4. Clean-Path Navigation & Per-Tab Density Contract
- **4 Top-Level Routes**: `/shift` (`Shift Station`), `/daily` (`Daily Shift`), `/caliper/ptbxl-001` (`12-Lead Calipers`), `/cohort` (`Cohort & Pro`).
- **Clean Cohort Sub-Routes**: `/cohort/overview`, `/cohort/roster`, `/cohort/roster/:seed`, `/cohort/assign`, `/cohort/billing` (with backward-compatible query hydration for legacy bookmarks).
- **Per-Tab Density Budget**:
  - Max 3 component groups at rest.
  - Max 4 data fields per bed tile at rest (`Bed ID`, `Rhythm`, `HR bpm`, `MAP / SpO2`).
  - At most 1 primary CTA button per active route.
  - All interactive controls enforce `40px x 40px` (`min-h-10`) minimum touch targets.
