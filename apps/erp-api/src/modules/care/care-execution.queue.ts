export const CARE_EXECUTION_QUEUE = 'care-execution';
export const CARE_EXECUTE_CASE_JOB = 'execute:care:case';

export interface CareExecutionJobData {
  readonly tenantId: string;
  readonly careCaseId: string;
}
