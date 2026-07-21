import { BadRequestException, Body, Controller, Get, Headers, Param, Post, Req } from '@nestjs/common';

import { AuditService } from '../../core/audit/audit.service.js';
import type { ErpRequest } from '../../core/http/request-context.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import { PayrollMasterDataService } from './application/payroll-master-data.service.js';
import { PayrollApprovalService } from './application/payroll-approval.service.js';
import { PayrollRunService, type PayrollPeriodSummary } from './application/payroll-run.service.js';
import { PayrollPayslipService, type PayrollPayslipView } from './application/payroll-payslip.service.js';
import {
  PayrollReconciliationService,
  type PayrollReconciliationSummary,
} from './application/payroll-reconciliation.service.js';
import {
  PayrollTaxFilingService,
  type PayrollTaxFilingSummary,
} from './application/payroll-tax-filing.service.js';
import {
  AttestCompensationProfileDto,
  AttestPayrollRulePackDto,
  ApprovePayrollTaxFilingDto,
  ApplyPayrollApprovalDto,
  CreatePayrollPeriodDto,
  LockPayrollPeriodDto,
  PayrollVersionCommandDto,
  PreparePayrollTaxFilingDto,
  StartPayrollCollectionDto,
  SubmitPayrollTaxFilingDto,
} from './application/payroll.dto.js';

@Controller('payroll')
export class PayrollController {
  constructor(
    private readonly runs: PayrollRunService,
    private readonly approvals: PayrollApprovalService,
    private readonly payslips: PayrollPayslipService,
    private readonly masterData: PayrollMasterDataService,
    private readonly taxFilings: PayrollTaxFilingService,
    private readonly reconciliations: PayrollReconciliationService,
    private readonly audit: AuditService,
  ) {}

  /** 四方对账只读控制摘要；不返回员工、账户、税务正文或外部对象地址。 */
  @Get('reconciliations/:id')
  @RequiredScopes('erp:payroll:reconciliation:read')
  async getReconciliation(@Param('id') id: string): Promise<PayrollReconciliationSummary> {
    const result = await this.reconciliations.getStatus(id);
    await this.audit.record({
      action: 'payroll.reconciliation.read', resourceType: 'payroll_reconciliation',
      resourceId: result.id, riskLevel: 'R1', outcome: 'success', metadata: {
        periodId: result.periodId, payrollRunId: result.payrollRunId,
        batchId: result.batchId, status: result.status,
        differenceCount: result.differences.length, evidenceHash: result.evidenceHash,
      },
    });
    return result;
  }

  /** 只读脱敏状态；不返回 WORM 对象引用、身份凭证或税务正文。 */
  @Get('tax-filings/:id')
  @RequiredScopes('erp:payroll:tax:read')
  async getTaxFiling(@Param('id') id: string): Promise<PayrollTaxFilingSummary> {
    const result = await this.taxFilings.getStatus(id);
    await this.auditTaxFiling('payroll.tax_filing.read', result, 'R1');
    return result;
  }

  /** R3：从锁定工资制备税务内部清单并写独立 WORM；不导出正文或直接申报。 */
  @Post('periods/:id/tax-filings')
  @RequiredScopes('erp:payroll:tax:prepare')
  async prepareTaxFiling(
    @Headers('idempotency-key') key: string | undefined,
    @Param('id') id: string,
    @Body() body: PreparePayrollTaxFilingDto,
  ): Promise<PayrollTaxFilingSummary> {
    const result = await this.taxFilings.prepare(this.key(key), id, body.expectedVersion);
    await this.audit.record({
      action: 'payroll.tax_filing.prepare', resourceType: 'payroll_tax_filing',
      resourceId: result.id, riskLevel: 'R3', outcome: 'success', metadata: {
        periodId: result.periodId, payrollRunId: result.payrollRunId,
        format: result.format, status: result.status, version: result.version,
        contentHash: result.contentHash, employeeCount: result.employeeCount,
        totalTaxableEarningsMinor: result.totalTaxableEarningsMinor,
        totalWithholdingTaxMinor: result.totalWithholdingTaxMinor,
        objectEvidenceId: result.objectEvidenceId ?? 'none',
      },
    });
    return result;
  }

  /** R3：审批人与工资制单、复核、锁定及税务制备人员隔离；MCP 永不注册此动作。 */
  @Post('tax-filings/:id/approval')
  @RequiredScopes('erp:payroll:tax:approve')
  async approveTaxFiling(
    @Headers('idempotency-key') key: string | undefined,
    @Param('id') id: string,
    @Body() body: ApprovePayrollTaxFilingDto,
    @Req() request: ErpRequest,
  ): Promise<PayrollTaxFilingSummary> {
    if (request.verifiedAccessToken === undefined) throw new BadRequestException({
      code: 'PAYROLL_TAX_APPROVAL_TOKEN_REQUIRED',
      message: '个税申报审批必须使用已验证人员访问令牌',
    });
    const result = await this.taxFilings.approve(
      this.key(key), id, body.expectedVersion, body.strongAuthEvidenceId,
      request.verifiedAccessToken,
    );
    await this.auditTaxFiling('payroll.tax_filing.approve', result, 'R3');
    return result;
  }

  /** R3：仅受信任税务连接器可提交 WORM 引用；MCP 永不注册此动作。 */
  @Post('tax-filings/:id/submission')
  @RequiredScopes('erp:payroll:tax:submit')
  async submitTaxFiling(
    @Headers('idempotency-key') key: string | undefined,
    @Param('id') id: string,
    @Body() body: SubmitPayrollTaxFilingDto,
  ): Promise<PayrollTaxFilingSummary> {
    const result = await this.taxFilings.submit(this.key(key), id, body.expectedVersion);
    await this.auditTaxFiling('payroll.tax_filing.submit', result, 'R3');
    return result;
  }

  @Post('periods')
  @RequiredScopes('erp:payroll:period:create')
  async createPeriod(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: CreatePayrollPeriodDto,
  ): Promise<PayrollPeriodSummary> {
    const result = await this.runs.createPeriod(this.key(key), body.period);
    await this.auditPeriod('payroll.period.create', result, 'R2');
    return result;
  }

  @Get('payslips/:period/me')
  @RequiredScopes('erp:payroll:sheet:read_self')
  async getMyPayslip(@Param('period') period: string): Promise<PayrollPayslipView> {
    const result = await this.payslips.getMyPayslip(period);
    await this.audit.record({
      action: 'payroll.payslip.read_self', resourceType: 'payroll_payslip',
      resourceId: period, riskLevel: 'R1', outcome: 'success', metadata: {
        period: result.period, inputHash: result.inputHash, resultHash: result.resultHash,
      },
    });
    return result;
  }

  @Post('periods/:id/approval')
  @RequiredScopes('erp:payroll:approval:request', 'erp:approval:instance:submit')
  async requestApproval(
    @Headers('idempotency-key') key: string | undefined,
    @Param('id') id: string,
    @Body() body: PayrollVersionCommandDto,
  ): Promise<PayrollPeriodSummary> {
    const result = await this.approvals.requestApproval(this.key(key), id, body.expectedVersion);
    await this.auditPeriod('payroll.approval.request', result, 'R2');
    return result;
  }

  @Post('periods/:id/approval-result')
  @RequiredScopes('erp:payroll:approval:sync')
  async applyApproval(
    @Headers('idempotency-key') key: string | undefined,
    @Param('id') id: string,
    @Body() body: ApplyPayrollApprovalDto,
  ): Promise<PayrollPeriodSummary> {
    const result = await this.approvals.applyApproval(
      this.key(key), id, body.expectedVersion, body.approvalInstanceId,
    );
    await this.auditPeriod('payroll.approval.apply', result, 'R2');
    return result;
  }

  /** R3：强认证 ceremony 的 operationId 必须使用工资周期 id；MCP 永不注册此动作。 */
  @Post('periods/:id/lock')
  @RequiredScopes('erp:payroll:period:lock')
  async lockPeriod(
    @Headers('idempotency-key') key: string | undefined,
    @Param('id') id: string,
    @Body() body: LockPayrollPeriodDto,
    @Req() request: ErpRequest,
  ): Promise<PayrollPeriodSummary> {
    if (request.verifiedAccessToken === undefined) throw new BadRequestException({
      code: 'PAYROLL_LOCK_TOKEN_REQUIRED', message: '工资锁定必须使用已验证人员访问令牌',
    });
    const result = await this.approvals.lockPeriod(
      this.key(key), id, body.expectedVersion, body.strongAuthEvidenceId,
      request.verifiedAccessToken,
    );
    await this.auditPeriod('payroll.period.lock', result, 'R3');
    return result;
  }

  @Post('periods/:id/collection')
  @RequiredScopes('erp:payroll:period:prepare')
  async startCollection(
    @Headers('idempotency-key') key: string | undefined,
    @Param('id') id: string,
    @Body() body: StartPayrollCollectionDto,
  ): Promise<PayrollPeriodSummary> {
    const result = await this.runs.startCollection(this.key(key), id, body.expectedVersion);
    await this.auditPeriod('payroll.period.start_collection', result, 'R2');
    return result;
  }

  @Get('periods/:id')
  @RequiredScopes('erp:payroll:period:read')
  async getPeriod(@Param('id') id: string): Promise<PayrollPeriodSummary> {
    const result = await this.runs.getPeriod(id);
    await this.auditPeriod('payroll.period.read', result, 'R0');
    return result;
  }

  /** 仅供受信任薪酬主数据连接器落地已审批版本，不接受普通用户调用。 */
  @Post('compensation-profiles/attest')
  @RequiredScopes('erp:payroll:compensation:attest')
  async attestCompensation(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: AttestCompensationProfileDto,
  ) {
    const result = await this.masterData.attestCompensation(this.key(key), body);
    await this.audit.record({
      action: 'payroll.compensation.attest', resourceType: 'payroll_compensation_profile',
      resourceId: result.id, riskLevel: 'R2', outcome: 'success', metadata: {
        employeeId: result.employeeId, version: result.version,
        effectiveFrom: result.effectiveFrom, effectiveTo: result.effectiveTo ?? 'open',
      },
    });
    return result;
  }

  /** 仅供受信任法定规则发布器落地带来源摘要和审批证据的规则包。 */
  @Post('rule-packs/attest')
  @RequiredScopes('erp:payroll:rule:attest')
  async attestRulePack(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: AttestPayrollRulePackDto,
  ) {
    const result = await this.masterData.attestRulePack(this.key(key), body);
    await this.audit.record({
      action: 'payroll.rule_pack.attest', resourceType: 'payroll_rule_pack',
      resourceId: result.id, riskLevel: 'R2', outcome: 'success', metadata: {
        code: result.code, jurisdictionCode: result.jurisdictionCode,
        version: result.version, effectiveFrom: result.effectiveFrom,
      },
    });
    return result;
  }

  private key(value: string | undefined): string {
    if (value === undefined || value.length === 0) throw new BadRequestException({
      code: 'IDEMPOTENCY_KEY_REQUIRED', message: '写接口必须提供 Idempotency-Key',
    });
    return value;
  }

  private async auditPeriod(
    action: string,
    period: PayrollPeriodSummary,
    riskLevel: 'R0' | 'R2' | 'R3',
  ): Promise<void> {
    await this.audit.record({
      action, resourceType: 'payroll_period', resourceId: period.id,
      riskLevel, outcome: 'success', metadata: {
        period: period.period, status: period.status, version: period.version,
        activeRunId: period.activeRunId ?? 'none',
        inputSnapshotHash: period.inputSnapshotHash ?? 'none',
        resultHash: period.resultHash ?? 'none', employeeCount: period.employeeCount ?? 0,
      },
    });
  }

  private async auditTaxFiling(
    action: string,
    filing: PayrollTaxFilingSummary,
    riskLevel: 'R1' | 'R3',
  ): Promise<void> {
    await this.audit.record({
      action, resourceType: 'payroll_tax_filing', resourceId: filing.id,
      riskLevel, outcome: 'success', metadata: {
        periodId: filing.periodId, payrollRunId: filing.payrollRunId,
        format: filing.format, status: filing.status, version: filing.version,
        contentHash: filing.contentHash, employeeCount: filing.employeeCount,
        totalTaxableEarningsMinor: filing.totalTaxableEarningsMinor,
        totalWithholdingTaxMinor: filing.totalWithholdingTaxMinor,
        objectEvidenceId: filing.objectEvidenceId ?? 'none',
        taxSubmissionId: filing.taxSubmissionId ?? 'none',
        taxSubmissionEvidenceId: filing.taxSubmissionEvidenceId ?? 'none',
      },
    });
  }
}
