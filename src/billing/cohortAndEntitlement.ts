import { computeCrc32 } from '../data/ptbxlLoader.ts';
import { fnv1a32 } from '../engine/prng.ts';
import type { PtbxlCaseRecord } from '../types/teleward.ts';

export type EntitlementTier = 'free' | 'exam_pass' | 'instructor_cohort';

export const COHORT_SEED_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
export const ENTITLEMENT_STORAGE_KEY = 'teleward_entitlement_v1';
const ENTITLEMENT_SALT = 'TELEWARD_CRC32_V1_2026';
const COHORT_CRC_SALT = 'TELEWARD_COHORT_CRC16_V1';

export interface ParsedCohortSeed {
  valid: boolean;
  cohort: string | null;
  numericSeed: number | null;
  reason?: string;
}

export function parseCohortSeed(raw: string | null | undefined): ParsedCohortSeed {
  if (!raw || typeof raw !== 'string') {
    return { valid: false, cohort: null, numericSeed: null, reason: 'EMPTY_COHORT' };
  }
  if (!COHORT_SEED_REGEX.test(raw)) {
    return {
      valid: false,
      cohort: null,
      numericSeed: null,
      reason: 'INVALID_COHORT_FORMAT',
    };
  }
  return {
    valid: true,
    cohort: raw,
    numericSeed: fnv1a32(raw),
  };
}

/**
 * Computes CRC-16-CCITT (poly 0x1021, init 0xFFFF) over UTF-8 string bytes.
 */
export function computeCrc16Hex(input: string): string {
  let crc = 0xffff;
  for (let i = 0; i < input.length; i++) {
    crc ^= (input.charCodeAt(i) & 0xff) << 8;
    for (let b = 0; b < 8; b++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export interface CohortReceiptPayload {
  cohort: string;
  scorePct: number;
  bedsStabilized: number;
  violations: number;
}

export function generateCohortReceipt(payload: CohortReceiptPayload): string {
  const parsed = parseCohortSeed(payload.cohort);
  if (!parsed.valid || !parsed.cohort) {
    throw new Error(`Invalid cohort seed "${payload.cohort}".`);
  }
  const score = Math.max(0, Math.min(100, Math.round(payload.scorePct)));
  const beds = Math.max(0, Math.min(4, Math.round(payload.bedsStabilized)));
  const viol = Math.max(0, Math.round(payload.violations));

  const canonical = `${COHORT_CRC_SALT}:${parsed.cohort}:${score}:${beds}:${viol}`;
  const crc16 = computeCrc16Hex(canonical);
  return `TW-${parsed.cohort}-${score}-${beds}B${viol}V-${crc16}`;
}

export interface VerifiedCohortReceipt {
  valid: boolean;
  cohort: string | null;
  scorePct: number | null;
  bedsStabilized: number | null;
  violations: number | null;
  reason: 'OK' | 'MALFORMED_RECEIPT' | 'INVALID_COHORT' | 'CRC16_MISMATCH';
}

export function verifyCohortReceipt(receipt: string): VerifiedCohortReceipt {
  const trimmed = (receipt ?? '').trim();
  const match = /^TW-([a-zA-Z0-9_-]{1,64})-(\d{1,3})-(\d)B(\d+)V-([0-9A-Fa-f]{4})$/.exec(
    trimmed
  );
  if (!match) {
    return {
      valid: false,
      cohort: null,
      scorePct: null,
      bedsStabilized: null,
      violations: null,
      reason: 'MALFORMED_RECEIPT',
    };
  }

  const cohort = match[1]!;
  const scorePct = Number(match[2]!);
  const bedsStabilized = Number(match[3]!);
  const violations = Number(match[4]!);
  const providedCrc = match[5]!.toUpperCase();

  if (scorePct < 0 || scorePct > 100 || bedsStabilized < 0 || bedsStabilized > 4) {
    return {
      valid: false,
      cohort: null,
      scorePct: null,
      bedsStabilized: null,
      violations: null,
      reason: 'MALFORMED_RECEIPT',
    };
  }

  const canonical = `${COHORT_CRC_SALT}:${cohort}:${scorePct}:${bedsStabilized}:${violations}`;
  const expectedCrc = computeCrc16Hex(canonical);
  if (providedCrc !== expectedCrc) {
    return {
      valid: false,
      cohort,
      scorePct,
      bedsStabilized,
      violations,
      reason: 'CRC16_MISMATCH',
    };
  }

  return {
    valid: true,
    cohort,
    scorePct,
    bedsStabilized,
    violations,
    reason: 'OK',
  };
}

function encodeAscii(str: string): Uint8Array {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    out[i] = str.charCodeAt(i) & 0xff;
  }
  return out;
}

export function createSignedEntitlementToken(
  tier: Exclude<EntitlementTier, 'free'>
): string {
  const payload = `${ENTITLEMENT_SALT}:${tier}`;
  const crc = computeCrc32(encodeAscii(payload))
    .toString(16)
    .padStart(8, '0');
  return `tw_pro_${tier}_${crc}`;
}

export function verifyEntitlementToken(token: string | null | undefined): {
  valid: boolean;
  tier: EntitlementTier;
} {
  if (!token || typeof token !== 'string') {
    return { valid: false, tier: 'free' };
  }
  const match = /^tw_pro_(exam_pass|instructor_cohort)_([0-9a-f]{8})$/i.exec(token.trim());
  if (!match) {
    return { valid: false, tier: 'free' };
  }
  const tier = match[1]!.toLowerCase() as Exclude<EntitlementTier, 'free'>;
  const sig = match[2]!.toLowerCase();
  const expected = createSignedEntitlementToken(tier).slice(-8).toLowerCase();

  if (sig !== expected) {
    return { valid: false, tier: 'free' };
  }
  return { valid: true, tier };
}

export interface StoredEntitlementState {
  tier: EntitlementTier;
  token: string | null;
  valid: boolean;
}

export function readEntitlementFromStorage(): StoredEntitlementState {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { tier: 'free', token: null, valid: true };
  }
  try {
    const raw = window.localStorage.getItem(ENTITLEMENT_STORAGE_KEY);
    if (!raw) {
      return { tier: 'free', token: null, valid: true };
    }
    const parsed = JSON.parse(raw) as { tier?: string; token?: string };
    const check = verifyEntitlementToken(parsed.token);
    if (!check.valid) {
      window.localStorage.removeItem(ENTITLEMENT_STORAGE_KEY);
      return { tier: 'free', token: null, valid: false };
    }
    return { tier: check.tier, token: parsed.token ?? null, valid: true };
  } catch {
    return { tier: 'free', token: null, valid: false };
  }
}

export function activateEntitlement(
  tier: Exclude<EntitlementTier, 'free'>,
  token?: string
): StoredEntitlementState {
  const signedToken = token ?? createSignedEntitlementToken(tier);
  const check = verifyEntitlementToken(signedToken);
  if (!check.valid) {
    return { tier: 'free', token: null, valid: false };
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.setItem(
        ENTITLEMENT_STORAGE_KEY,
        JSON.stringify({ tier: check.tier, token: signedToken })
      );
    } catch {
      // Ignore storage quota errors while preserving in-memory return
    }
  }
  return { tier: check.tier, token: signedToken, valid: true };
}

export function canAccessCaseWithEntitlement(
  record: PtbxlCaseRecord,
  tier: EntitlementTier,
  cohortSeed: string | null
): boolean {
  if (record.freeStarter) return true;
  if (tier === 'exam_pass' || tier === 'instructor_cohort') return true;
  if (cohortSeed && parseCohortSeed(cohortSeed).valid) return true;
  return false;
}
