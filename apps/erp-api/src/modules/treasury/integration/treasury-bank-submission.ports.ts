export interface TreasuryBankSubmissionReceipt {
  readonly submissionId: string;
  readonly evidenceId: string;
  readonly accepted: true;
}

export abstract class TreasuryBankSubmissionGateway {
  /** 网关按 objectRef 读取不可变文件；请求与回执必须绑定同一批次和摘要。 */
  abstract submit(input: {
    readonly tenantId: string;
    readonly batchId: string;
    readonly objectRef: string;
    readonly fileHash: string;
    readonly lineCount: number;
    readonly totalMinor: number;
  }): Promise<TreasuryBankSubmissionReceipt>;
}
