# TeleWard — Project Plan (v2.0 Commercial Audit & UI Redesign)

## 1. Product Vision
TeleWard is a deterministic browser-and-CLI ICU central telemetry station, 12-lead ECG caliper workbench, and AHA ACLS physiological crisis simulator powered by a curated 120-record PhysioNet PTB-XL binary waveform bank (`public/data/ptbxl_120.bin`).

## 2. Architecture & Design Contracts
- **Calm 2-Region Default Shell**: Top clinical telemetry bar (`52px`) + focused main canvas. Context-scoped left rail (`#tw-scope-sidebar`) renders only one navigation scope per route (`Ward Beds` on `/shift` and `/daily`; `Rhythm Class` on `/caliper/:caseId`; hidden on `/cohort/*`).
- **On-Demand Slide-Over Drawers**: The `Code Cart` (`data-testid="code-cart-drawer"`) and `ACLS Causal Timeline` (`data-testid="causal-timeline-inspector"`) open on demand without crowding the 4-bed waveform monitor at rest.
- **Clean-Path Routing (`src/ui/router.ts`)**:
  - `/shift` — 4-Bed ICU Shift Station
  - `/daily` — UTC-Seeded Daily Ward Shift & Standings
  - `/caliper/:caseId` — 3x4 Clinical 12-Lead ECG Caliper Workbench (`25 mm/s` / `50 mm/s`, `10 mm/mV`)
  - `/cohort`, `/cohort/overview`, `/cohort/roster`, `/cohort/roster/:seed`, `/cohort/assign`, `/cohort/billing` — Instructor Cohort Management & Pro Access
- **Hardened REST Backend (`src/server/apiServer.ts`)**:
  - `withStoreLock()` async mutex + `renameWithRetrySync()` atomic persistence
  - `verifyShiftReplay()` server-side deterministic ACLS intervention replay
  - `GET /api/cohorts/:seed/export.csv` formula-sanitized CSV roster export
  - `POST /api/billing/webhook` HMAC-SHA256 Stripe webhook verification & event deduplication
  - `GET /api/cases/:caseId/waveforms` Pro entitlement gate (`403 FORBIDDEN_ENTITLEMENT` on locked records)
  - Bounded `4096`-entry IP rate limiter (`resolveClientIp` + `checkRateLimit`)

## 3. Tracer-Bullet Tickets (`T-01`..`T-08`)
| Ticket | Scope | Verification |
|---|---|---|
| `T-01` | Server Replay Verification, Store Mutex, CSV Formula Sanitization & Webhook Idempotency | `npx vitest run tests/backend-api.test.ts tests/cohort-and-billing.test.ts` |
| `T-02` | Pro Binary Asset Entitlement Gate & Compiler Finite Float Guard | `npx vitest run tests/backend-api.test.ts tests/compiler-and-loader.test.ts` |
| `T-03` | Clinical Stabilization Unification, 300s Shift Horizon & CLI Parity | `npx vitest run tests/physiology-and-acls.test.ts tests/acls-engine-and-cli.test.ts` |
| `T-04` | 3x4 Clinical 12-Lead Caliper Layout, PR Exemption & True Millimeter Grid | `npx vitest run tests/telemetry-and-calipers.test.tsx` |
| `T-05` | IEC 60601-1-8 WebAudio Lifecycle & Async Arming | `npx vitest run tests/ui-station-and-caliper.test.tsx` |
| `T-06` | Design System (`design.md` v2.0), Google Fonts & `detect.mjs` Compliance | `node ~/.gemini/antigravity/skills/impeccable/scripts/detect.mjs --json src/ index.html` |
| `T-07` | Calm 2-Region Shell, Clean-Path Router & On-Demand Drawers | `npx vitest run tests/ui-station-and-caliper.test.tsx tests/cohort-and-billing.test.tsx` |
| `T-08` | 50-Row ASD-STE100 UI Copy Sweep & End-to-End Verification | `npm run lint && npm run typecheck && npm test && npm run build` |
