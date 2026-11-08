import { parseCohortSeed } from '../billing/cohortAndEntitlement.ts';

export type ActiveRouteArea = 'shift' | 'daily' | 'caliper' | 'cohort';
export type CohortSubRoute = 'overview' | 'roster' | 'assign' | 'billing';

export interface ParsedTelewardRoute {
  area: ActiveRouteArea;
  pathname: string;
  caseId: string;
  cohortSubRoute: CohortSubRoute;
  cohortSeed: string | null;
  rawCohortParam: string | null;
  invalidCohortParam: boolean;
  checkoutStatus: 'success' | 'cancelled' | null;
  checkoutTier: 'exam_pass' | 'instructor_cohort' | null;
  checkoutToken: string | null;
}

/**
 * Decodes a URL path segment and returns the raw segment when percent-encoding is malformed.
 */
function safeDecodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Parses clean path routes (/shift, /daily, /caliper/:caseId, /cohort/overview, /cohort/roster/:seed, /cohort/assign, /cohort/billing) and legacy query parameters.
 */
export function parseTelewardRoute(rawPath: string): ParsedTelewardRoute {
  const [rawPathname = '/shift', searchPart = ''] = rawPath.split('?');
  const pathname = rawPathname.trim() || '/shift';
  const segments = pathname
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);

  const urlParams = new URLSearchParams(searchPart);
  const queryCohortParam = urlParams.get('cohort');
  const queryCheckout = urlParams.get('checkout');
  const queryTier = urlParams.get('tier');
  const queryToken = urlParams.get('token')?.trim() ?? null;

  const first = segments[0]?.toLowerCase() ?? 'shift';
  const area: ActiveRouteArea =
    first === 'daily'
      ? 'daily'
      : first === 'caliper'
        ? 'caliper'
        : first === 'cohort'
          ? 'cohort'
          : 'shift';

  const caseId =
    area === 'caliper' && segments[1]
      ? safeDecodeSegment(segments[1])
      : 'ptbxl-001';

  let cohortSubRoute: CohortSubRoute = 'roster';
  let pathCohortCandidate: string | null = null;
  let pathCheckoutStatus: 'success' | 'cancelled' | null = null;
  let pathCheckoutTier: 'exam_pass' | 'instructor_cohort' | null = null;
  let pathCheckoutToken: string | null = null;

  if (area === 'cohort') {
    const sub = segments[1]?.toLowerCase() ?? 'roster';
    if (sub === 'overview') {
      cohortSubRoute = 'overview';
      if (segments[2]) {
        pathCohortCandidate = safeDecodeSegment(segments[2]);
      }
    } else if (sub === 'assign' || sub === 'verifier') {
      cohortSubRoute = 'assign';
    } else if (sub === 'billing' || sub === 'access') {
      cohortSubRoute = 'billing';
      const billingAction = segments[2]?.toLowerCase();
      if (billingAction === 'cancelled') {
        pathCheckoutStatus = 'cancelled';
      } else if (billingAction === 'success') {
        pathCheckoutStatus = 'success';
        const tierSeg = segments[3];
        if (tierSeg === 'exam_pass' || tierSeg === 'instructor_cohort') {
          pathCheckoutTier = tierSeg;
        }
        if (segments[4]) {
          pathCheckoutToken = safeDecodeSegment(segments[4]);
        }
      }
    } else if (sub === 'roster') {
      cohortSubRoute = 'roster';
      if (segments[2]) {
        pathCohortCandidate = safeDecodeSegment(segments[2]);
      }
    } else {
      cohortSubRoute = 'roster';
      pathCohortCandidate = safeDecodeSegment(segments[1]!);
    }
  } else if (area === 'shift' && segments[1]?.toLowerCase() === 'cohort' && segments[2]) {
    pathCohortCandidate = safeDecodeSegment(segments[2]);
  }

  const rawCohortParam = pathCohortCandidate ?? queryCohortParam;
  const parsedSeed = parseCohortSeed(rawCohortParam);

  const checkoutStatus: 'success' | 'cancelled' | null =
    pathCheckoutStatus ??
    (queryCheckout === 'success' || queryCheckout === 'cancelled' ? queryCheckout : null);

  const checkoutTier: 'exam_pass' | 'instructor_cohort' | null =
    pathCheckoutTier ??
    (queryTier === 'exam_pass' || queryTier === 'instructor_cohort' ? queryTier : null);

  const checkoutToken = pathCheckoutToken ?? queryToken;

  return {
    area,
    pathname,
    caseId,
    cohortSubRoute,
    cohortSeed: parsedSeed.valid ? parsedSeed.cohort : null,
    rawCohortParam,
    invalidCohortParam: rawCohortParam !== null && !parsedSeed.valid,
    checkoutStatus,
    checkoutTier,
    checkoutToken,
  };
}

/**
 * Formats a clean Cohort Pro sub-route path without query strings.
 */
export function buildCohortSubPath(
  subRoute: CohortSubRoute,
  cohortSeed?: string | null
): string {
  const cleanSeed = cohortSeed ? parseCohortSeed(cohortSeed) : null;
  if (subRoute === 'roster') {
    return cleanSeed?.valid && cleanSeed.cohort
      ? `/cohort/roster/${encodeURIComponent(cleanSeed.cohort)}`
      : '/cohort/roster';
  }
  if (subRoute === 'overview') {
    return '/cohort/overview';
  }
  if (subRoute === 'assign') {
    return '/cohort/assign';
  }
  return '/cohort/billing';
}
