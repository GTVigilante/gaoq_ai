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
  readonly productionAuthorizationEvidenceId: string | null;
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
    readonly productionAuthorization: ProductionExecutionAuthorization | null;
  }): Promise<PayrollTaxSubmissionReceipt>;
}

export interface PayrollOfficialAnnualAssessment {
  readonly assessmentId: string;
  readonly assessmentEvidenceId: string;
  readonly assessedTaxMinor: number;
  readonly sourceDigest: string;
}

export interface PayrollAnnualSettlementLink {
  readonly settlementUrl: string;
  readonly expiresAt: string;
}

export abstract class PayrollAnnualAssessmentGateway {
  /** 从隔离税务网关读取并验签官方年度评估；ERP 不接受调用方声明的评估值。 */
  abstract resolve(input: {
    readonly tenantId: string;
    readonly employeeId: string;
    readonly taxYear: string;
    readonly idempotencyKey: string;
  }): Promise<PayrollOfficialAnnualAssessment>;

  /** 创建员工本人短时官方办理链接；网关不得代 ERP 执行个人申报。 */
  abstract createSettlementLink(input: {
    readonly tenantId: string;
    readonly employeeId: string;
    readonly annualReconciliationId: string;
    readonly taxYear: string;
    readonly evidenceHash: string;
    readonly idempotencyKey: string;
  }): Promise<PayrollAnnualSettlementLink>;
}
import type { ProductionExecutionAuthorization } from '../../../core/production-execution/production-execution-authorization.service.js';
