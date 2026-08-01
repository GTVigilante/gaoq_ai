export interface DataMigrationAttachmentReceipt {
  readonly schemaVersion: 'erp-data-migration-attachment-receipt.v1';
  readonly tenantId: string;
  readonly runId: string;
  readonly sourceSystem: string;
  readonly sourceAttachmentId: string;
  readonly targetEvidenceId: string;
  readonly malwareScanEvidenceId: string;
  readonly checksum: string;
  readonly immutable: true;
  readonly malwareClean: true;
  readonly retentionDays: number;
  readonly classification: 'L3' | 'L4';
}

export abstract class DataMigrationAttachmentGateway {
  /** 隔离网关自行拉取来源正文；ERP 只发送标识、摘要和保留策略。 */
  abstract transfer(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly sourceSystem: string;
    readonly sourceAttachmentId: string;
    readonly expectedChecksum: string;
    readonly retentionDays: number;
    readonly classification: 'L3' | 'L4';
  }): Promise<DataMigrationAttachmentReceipt>;
}
