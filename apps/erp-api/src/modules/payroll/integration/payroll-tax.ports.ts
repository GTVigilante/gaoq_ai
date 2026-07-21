export interface PayrollTaxArchiveReceipt {
  readonly objectRef: string;
  readonly evidenceId: string;
  readonly immutable: true;
}

export abstract class PayrollTaxImmutableArchive {
  abstract put(input: {
    readonly tenantId: string;
    readonly filingId: string;
    readonly objectKey: string;
    readonly sha256: string;
    readonly bytes: Buffer;
  }): Promise<PayrollTaxArchiveReceipt>;
}

export interface PayrollTaxSubmissionReceipt {
  readonly submissionId: string;
  readonly evidenceId: string;
  readonly accepted: true;
}

export abstract class PayrollTaxGateway {
  /** 网关读取 WORM 清单后解析身份凭证、转换官方格式并向税局申报。 */
  abstract submit(input: {
    readonly tenantId: string;
    readonly filingId: string;
    readonly period: string;
    readonly objectRef: string;
    readonly contentHash: string;
    readonly employeeCount: number;
    readonly totalTaxableEarningsMinor: number;
    readonly totalWithholdingTaxMinor: number;
  }): Promise<PayrollTaxSubmissionReceipt>;
}
