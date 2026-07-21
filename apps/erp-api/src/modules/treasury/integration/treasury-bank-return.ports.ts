export interface TreasuryBankReturnLine {
  readonly instructionId: string;
  readonly outcome: 'succeeded' | 'failed';
  readonly amountMinor: number;
  readonly bankLineReference: string;
}

export interface TreasuryBankReturnManifest {
  readonly returnId: string;
  readonly tenantId: string;
  readonly batchId: string;
  readonly bankSubmissionId: string;
  readonly sequence: number;
  readonly returnHash: string;
  readonly objectRef: string;
  readonly objectEvidenceId: string;
  readonly signatureEvidenceId: string;
  readonly signatureVerified: boolean;
  readonly malwareScanEvidenceId: string;
  readonly malwareClean: boolean;
  readonly receivedAt: string;
  readonly lines: readonly TreasuryBankReturnLine[];
}

export abstract class TreasuryBankReturnInbox {
  /** Inbox 只返回已限流规范清单和文件防护证据，永不返回原始银行文件。 */
  abstract claim(input: {
    readonly tenantId: string;
    readonly batchId: string;
    readonly bankSubmissionId: string;
  }): Promise<TreasuryBankReturnManifest>;
}
