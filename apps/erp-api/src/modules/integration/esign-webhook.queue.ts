import { createHash } from 'node:crypto';

export const ESIGN_WEBHOOK_QUEUE = 'integration-esign-webhook';
export const ESIGN_PROCESS_WEBHOOK_JOB = 'process:esign:webhook';
export const ESIGN_ARCHIVE_EVIDENCE_JOB = 'archive:esign:evidence';
export const ESIGN_RECONCILE_FLOWS_JOB = 'reconcile:esign:flows';
export const ESIGN_ISSUE_FLOW_JOB = 'issue:esign:flow';

export interface ESignWebhookJobData {
  readonly inboxId: string;
  readonly tenantId: string;
  readonly providerEventId: string;
}

export interface ESignEvidenceArchiveJobData {
  readonly flowId: string;
  readonly tenantId: string;
}

export interface ESignIssuanceJobData {
  readonly requestId: string;
  readonly tenantId: string;
}

export type ESignReconciliationJobData = Record<string, never>;

export type ESignQueueJobData =
  | ESignWebhookJobData
  | ESignEvidenceArchiveJobData
  | ESignIssuanceJobData
  | ESignReconciliationJobData;

/** 任务标识绑定租户、Inbox 与供应商事件摘要，禁止跨租户或替换载荷复用。 */
export function createESignWebhookJobId(
  tenantId: string,
  inboxId: string,
  providerEventId: string,
): string {
  return `esign_webhook_${digest(['webhook', tenantId, inboxId, providerEventId])}`;
}

/** 证据归档任务标识绑定租户与流程；失败 Job 移除后可由补拉安全重建。 */
export function createESignEvidenceJobId(tenantId: string, flowId: string): string {
  return `esign_evidence_${digest(['evidence', tenantId, flowId])}`;
}

/** 发起任务标识绑定租户与持久化请求；任务载荷不得携带文件或签署主体。 */
export function createESignIssuanceJobId(tenantId: string, requestId: string): string {
  return `esign_issuance_${digest(['issuance', tenantId, requestId])}`;
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('base64url');
}
