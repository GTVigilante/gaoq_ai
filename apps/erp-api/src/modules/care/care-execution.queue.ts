export const CARE_EXECUTION_QUEUE = 'care-execution';
export const CARE_EXECUTE_CASE_JOB = 'execute:care:case';
export const CARE_EXPIRE_ALUMNI_CONSENT_JOB = 'expire:care:alumni-consent';
export const CARE_DISPATCH_OCCASION_JOB = 'dispatch:care:occasion';
export const CARE_RECONCILE_OCCASIONS_JOB = 'reconcile:care:occasions';

export interface CareExecutionJobData {
  readonly tenantId: string;
  readonly careCaseId: string;
}

export interface CareAlumniConsentExpiryJobData {
  readonly tenantId: string;
  readonly consentId: string;
}

/** 队列只携带任务标识；不携带生日、联系方式、渠道地址或通知正文。 */
export interface CareOccasionDispatchJobData {
  readonly tenantId: string;
  readonly occasionTaskId: string;
}

/** 全局对账任务为空载荷，租户从服务端注册表枚举。 */
export type CareOccasionReconcileJobData = Readonly<Record<never, never>>;

export type CareJobData =
  | CareExecutionJobData
  | CareAlumniConsentExpiryJobData
  | CareOccasionDispatchJobData
  | CareOccasionReconcileJobData;
