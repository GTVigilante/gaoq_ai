export const ESIGN_WEBHOOK_QUEUE = 'integration-esign-webhook';
export const ESIGN_PROCESS_WEBHOOK_JOB = 'process:esign:webhook';
export const ESIGN_ARCHIVE_EVIDENCE_JOB = 'archive:esign:evidence';
export const ESIGN_RECONCILE_FLOWS_JOB = 'reconcile:esign:flows';

export interface ESignWebhookJobData {
  readonly inboxId: string;
  readonly tenantId: string;
}

export interface ESignEvidenceArchiveJobData {
  readonly flowId: string;
  readonly tenantId: string;
}

export type ESignReconciliationJobData = Record<string, never>;

export type ESignQueueJobData =
  | ESignWebhookJobData
  | ESignEvidenceArchiveJobData
  | ESignReconciliationJobData;
