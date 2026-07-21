export const ESIGN_WEBHOOK_QUEUE = 'integration-esign-webhook';
export const ESIGN_PROCESS_WEBHOOK_JOB = 'process:esign:webhook';

export interface ESignWebhookJobData {
  readonly inboxId: string;
  readonly tenantId: string;
}
