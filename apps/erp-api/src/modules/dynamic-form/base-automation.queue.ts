import { createHash } from 'node:crypto';

export const BASE_AUTOMATION_QUEUE = 'base-automation';
export const BASE_AUTOMATION_RELAY_JOB = 'relay:base-automations';
export const BASE_AUTOMATION_EXECUTE_JOB = 'execute:base-automation';

export type BaseAutomationJobData = Readonly<Record<never, never>> | {
  readonly tenantId: string;
  readonly runId: string;
};

export function baseAutomationJobId(tenantId: string, runId: string): string {
  return createHash('sha256').update(`base-automation-v1:${tenantId}:${runId}`).digest('base64url');
}
