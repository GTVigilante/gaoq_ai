export const CARE_EXECUTION_QUEUE = 'care-execution';
export const CARE_EXECUTE_CASE_JOB = 'execute:care:case';
export const CARE_EXPIRE_ALUMNI_CONSENT_JOB = 'expire:care:alumni-consent';

export interface CareExecutionJobData {
  readonly tenantId: string;
  readonly careCaseId: string;
}

export interface CareAlumniConsentExpiryJobData {
  readonly tenantId: string;
  readonly consentId: string;
}

export type CareJobData = CareExecutionJobData | CareAlumniConsentExpiryJobData;
