import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { AuditService } from '../../core/audit/audit.service.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import {
  CareApplicationService,
  type CareCaseSummary,
  type AlumniConsentSummary,
} from './application/care-application.service.js';
import {
  CreateAlumniConsentDto,
  CreateOffboardingCaseDto,
  RecordCareTaskEvidenceDto,
} from './application/care.dto.js';
import type { CareTaskCode } from './domain/index.js';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const IF_MATCH = /^"([1-9][0-9]*)"$/;
const TASKS = new Set<CareTaskCode>([
  'handover_accepted', 'assets_cleared', 'finance_cleared', 'data_retention_confirmed',
]);

@Controller('care')
export class CareController {
  constructor(
    private readonly care: CareApplicationService,
    private readonly audit: AuditService,
  ) {}

  @Post('offboarding-cases')
  @RequiredScopes('erp:care:case:create', 'erp:care:employment:read')
  async create(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: CreateOffboardingCaseDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly careCase: CareCaseSummary }> {
    const result = await this.care.create(this.key(key), body);
    this.etag(response, result.careCase.version);
    await this.auditCase('care.case.create', result.careCase, 'R2');
    return result;
  }

  @Get('cases/:id')
  @RequiredScopes('erp:care:case:read', 'erp:care:employment:read')
  async get(
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CareCaseSummary> {
    const result = await this.care.get(this.id(id));
    this.etag(response, result.version);
    return result;
  }

  @Post('cases/:id/submit')
  @HttpCode(200)
  @RequiredScopes('erp:care:case:submit', 'erp:care:employment:read')
  async submit(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly careCase: CareCaseSummary }> {
    const result = await this.care.submit(this.id(id), this.version(ifMatch), this.key(key));
    this.etag(response, result.careCase.version);
    await this.auditCase('care.case.submit', result.careCase, 'R2');
    return result;
  }

  @Post('cases/:id/sync-approval')
  @HttpCode(200)
  @RequiredScopes('erp:care:approval:sync')
  async syncApproval(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly careCase: CareCaseSummary }> {
    const result = await this.care.syncApproval(
      this.id(id), this.version(ifMatch), this.key(key),
    );
    this.etag(response, result.careCase.version);
    await this.auditCase('care.case.sync_approval', result.careCase, 'R2');
    return result;
  }

  @Post('cases/:id/tasks/:taskCode/evidence')
  @HttpCode(200)
  @RequiredScopes('erp:care:task:record')
  async recordTaskEvidence(
    @Param('id') id: string,
    @Param('taskCode') taskCode: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: RecordCareTaskEvidenceDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly careCase: CareCaseSummary }> {
    const result = await this.care.recordTaskEvidence(
      this.id(id), this.version(ifMatch), this.key(key), this.task(taskCode), body.evidenceId,
    );
    this.etag(response, result.careCase.version);
    await this.auditCase('care.case.task_evidence', result.careCase, 'R2', { taskCode });
    return result;
  }

  @Post('cases/:id/schedule')
  @HttpCode(200)
  @RequiredScopes('erp:care:case:schedule', 'erp:care:employment:read')
  async schedule(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly careCase: CareCaseSummary }> {
    const result = await this.care.schedule(this.id(id), this.version(ifMatch), this.key(key));
    this.etag(response, result.careCase.version);
    await this.auditCase('care.case.schedule', result.careCase, 'R2');
    return result;
  }

  @Post('cases/:id/alumni-consents')
  @RequiredScopes('erp:care:alumni:consent:attest', 'erp:care:employment:read')
  async createAlumniConsent(
    @Param('id') id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: CreateAlumniConsentDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly consent: AlumniConsentSummary }> {
    const result = await this.care.createAlumniConsent(this.id(id), this.key(key), body);
    this.etag(response, result.consent.version);
    await this.audit.record({
      action: 'care.alumni_consent.create', resourceType: 'care_alumni_consent',
      resourceId: result.consent.id, riskLevel: 'R2', outcome: 'success',
      metadata: { purpose: result.consent.purpose, expiresAt: result.consent.expiresAt },
    });
    return result;
  }

  @Post('alumni-consents/:id/withdraw')
  @HttpCode(200)
  @RequiredScopes('erp:care:alumni:consent:withdraw')
  async withdrawAlumniConsent(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly consent: AlumniConsentSummary }> {
    const result = await this.care.withdrawAlumniConsent(
      this.id(id), this.version(ifMatch), this.key(key),
    );
    this.etag(response, result.consent.version);
    await this.audit.record({
      action: 'care.alumni_consent.withdraw', resourceType: 'care_alumni_consent',
      resourceId: result.consent.id, riskLevel: 'R2', outcome: 'success',
      metadata: { status: result.consent.status, version: result.consent.version },
    });
    return result;
  }

  private id(value: string): string {
    if (!ULID.test(value)) throw new BadRequestException({
      code: 'CARE_ID_INVALID', message: '资源标识必须为严格 ULID',
    });
    return value;
  }

  private key(value: string | undefined): string {
    if (value === undefined || value.length === 0) throw new BadRequestException({
      code: 'IDEMPOTENCY_KEY_REQUIRED', message: '写接口必须提供 Idempotency-Key',
    });
    return value;
  }

  private version(value: string | undefined): number {
    const match = IF_MATCH.exec(value ?? '');
    const version = Number(match?.[1]);
    if (match?.[1] === undefined || !Number.isSafeInteger(version)) throw new BadRequestException({
      code: 'CARE_IF_MATCH_REQUIRED', message: '写接口必须提供强 If-Match，例如 "2"',
    });
    return version;
  }

  private task(value: string): CareTaskCode {
    if (!TASKS.has(value as CareTaskCode)) throw new BadRequestException({
      code: 'CARE_TASK_CODE_INVALID', message: '清算任务编码非法',
    });
    return value as CareTaskCode;
  }

  private etag(response: Response, version: number): void {
    response.setHeader('ETag', `"${version}"`);
  }

  private async auditCase(
    action: string,
    careCase: CareCaseSummary,
    riskLevel: 'R1' | 'R2',
    extra: Readonly<Record<string, string | number | boolean>> = {},
  ): Promise<void> {
    await this.audit.record({
      action, resourceType: 'care_case', resourceId: careCase.id,
      riskLevel, outcome: 'success', metadata: {
        status: careCase.status, version: careCase.version,
        employeeId: careCase.employeeId, lastWorkingDate: careCase.lastWorkingDate, ...extra,
      },
    });
  }
}
