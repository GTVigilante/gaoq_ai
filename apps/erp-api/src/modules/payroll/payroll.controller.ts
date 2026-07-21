import { BadRequestException, Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';

import { AuditService } from '../../core/audit/audit.service.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import { PayrollMasterDataService } from './application/payroll-master-data.service.js';
import { PayrollRunService, type PayrollPeriodSummary } from './application/payroll-run.service.js';
import {
  AttestCompensationProfileDto,
  AttestPayrollRulePackDto,
  CreatePayrollPeriodDto,
  StartPayrollCollectionDto,
} from './application/payroll.dto.js';

@Controller('payroll')
export class PayrollController {
  constructor(
    private readonly runs: PayrollRunService,
    private readonly masterData: PayrollMasterDataService,
    private readonly audit: AuditService,
  ) {}

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
    riskLevel: 'R0' | 'R2',
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
}
