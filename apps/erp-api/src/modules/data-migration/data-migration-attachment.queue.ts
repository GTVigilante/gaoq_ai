export const DATA_MIGRATION_ATTACHMENT_QUEUE = 'data-migration-attachment';
export const DATA_MIGRATION_ATTACHMENT_TRANSFER_JOB = 'data-migration.attachment.transfer';

export interface DataMigrationAttachmentJobData {
  readonly tenantId: string;
  readonly runId: string;
}
