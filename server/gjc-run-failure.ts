/**
 * Why a GJC run failed, in words the chat can show.
 *
 * The worker protocol carries fixed codes, never provider text: the provider's
 * own message already reaches the transcript as its error row, and this module
 * only decides which fixed sentence describes the cause. A run the classifier
 * cannot place is still the run's failure, not the worker's - the generic
 * "worker failed" text used to send operators after a process that was fine.
 */
export const GJC_RUN_FAILED_CODE = 'run_failed';
export const GJC_RUN_FAILED_MESSAGE = 'GJC run failed.';
export const GJC_USAGE_LIMIT_CODE = 'usage_limit';
export const GJC_USAGE_LIMIT_MESSAGE = "The provider's usage limit was reached. Wait for it to reset or switch models.";
export const GJC_AUTH_FAILED_CODE = 'auth_failed';
export const GJC_AUTH_FAILED_MESSAGE = 'The provider rejected the saved sign-in. Sign in again.';

export type GjcRunFailureKind = 'usage_limit' | 'auth';

const USAGE_LIMIT = /usage limit|quota|out of credits|credit balance|billing|rate limit|\b429\b/i;
const AUTH_FAILED = /unauthori[sz]ed|authentication|invalid api key|api key.*invalid|sign in|log ?in|\b401\b/i;

/** Classifies provider error text; the text itself never leaves the worker. */
export function classifyGjcRunFailure(text: unknown): GjcRunFailureKind | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  if (USAGE_LIMIT.test(text)) return 'usage_limit';
  if (AUTH_FAILED.test(text)) return 'auth';
  return null;
}

const BY_KIND = {
  usage_limit: { code: GJC_USAGE_LIMIT_CODE, message: GJC_USAGE_LIMIT_MESSAGE },
  auth: { code: GJC_AUTH_FAILED_CODE, message: GJC_AUTH_FAILED_MESSAGE },
} as const;

export function gjcRunFailure(kind: GjcRunFailureKind | null | undefined): { code: string; message: string } {
  return (kind ? BY_KIND[kind] : null) ?? { code: GJC_RUN_FAILED_CODE, message: GJC_RUN_FAILED_MESSAGE };
}
