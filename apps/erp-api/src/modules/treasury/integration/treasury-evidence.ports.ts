export interface TreasuryArchiveReceipt {
  readonly objectRef: string;
  readonly receiptId: string;
  readonly immutable: true;
}

export abstract class TreasuryImmutableArchive {
  /** objectKey 与 sha256 共同保证重试幂等；实现必须返回同一不可变对象证据。 */
  abstract put(input: {
    readonly tenantId: string;
    readonly batchId: string;
    readonly objectKey: string;
    readonly contentType: 'application/xml';
    readonly classification: 'L4';
    readonly retentionPolicy: 'payroll_disbursement';
    readonly sha256: string;
    readonly bytes: Buffer;
  }): Promise<TreasuryArchiveReceipt>;
}
