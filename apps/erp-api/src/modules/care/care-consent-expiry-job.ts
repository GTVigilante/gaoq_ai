import { createHash } from 'node:crypto';

import type { JobsOptions } from 'bullmq';

import {
  CARE_EXPIRE_ALUMNI_CONSENT_JOB,
  type CareAlumniConsentExpiryJobData,
} from './care-execution.queue.js';

export interface CareConsentExpiryJobDefinition {
  readonly name: typeof CARE_EXPIRE_ALUMNI_CONSENT_JOB;
  readonly data: CareAlumniConsentExpiryJobData;
  readonly opts: JobsOptions;
}

export function buildCareConsentExpiryJob(
  input: CareAlumniConsentExpiryJobData & { readonly expiresAt: string },
  now = Date.now(),
): CareConsentExpiryJobDefinition {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.tenantId)) {
    throw new Error('CARE_CONSENT_EXPIRY_TENANT_INVALID');
  }
  if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(input.consentId)) {
    throw new Error('CARE_CONSENT_EXPIRY_ID_INVALID');
  }
  const expiresAt = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiresAt)) throw new Error('CARE_CONSENT_EXPIRY_TIME_INVALID');
  const jobId = createHash('sha256').update(
    JSON.stringify([input.tenantId, input.consentId, 'alumni-consent-expiry']), 'utf8',
  ).digest('base64url');
  return Object.freeze({
    name: CARE_EXPIRE_ALUMNI_CONSENT_JOB,
    data: Object.freeze({ tenantId: input.tenantId, consentId: input.consentId }),
    opts: Object.freeze({
      jobId, delay: Math.max(0, expiresAt - now), attempts: 20,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: 1_000, removeOnFail: 10_000,
    }),
  });
}
