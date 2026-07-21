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
  OnboardingApplicationService,
  type OnboardingSummary,
} from './application/onboarding-application.service.js';
import { RecordOnboardingTaskEvidenceDto } from './application/onboarding.dto.js';
import type { OnboardingTaskCode } from './domain/index.js';

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const IF_MATCH_PATTERN = /^"([1-9][0-9]*)"$/;
const HUMAN_TASKS = new Set<OnboardingTaskCode>([
  'materials_verified', 'org_assignment_verified',
]);

@Controller('onboarding')
export class OnboardingController {
  constructor(
    private readonly onboarding: OnboardingApplicationService,
    private readonly audit: AuditService,
  ) {}

  @Post('from-offer/:offerId')
  @RequiredScopes('erp:onboarding:create')
  async create(
    @Param('offerId') offerId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly onboarding: OnboardingSummary }> {
    const result = await this.onboarding.createFromOffer(
      this.requireUlid(offerId), this.requireKey(key),
    );
    this.setVersion(response, result.onboarding.version);
    await this.auditSuccess('onboarding.instance.create', result.onboarding, 'R2');
    return result;
  }

  @Get(':id')
  @RequiredScopes('erp:onboarding:read')
  async get(
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OnboardingSummary> {
    const result = await this.onboarding.get(this.requireUlid(id));
    this.setVersion(response, result.version);
    return result;
  }

  @Post(':id/tasks/:taskCode/evidence')
  @HttpCode(200)
  @RequiredScopes('erp:onboarding:task:complete')
  async recordTaskEvidence(
    @Param('id') id: string,
    @Param('taskCode') taskCode: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: RecordOnboardingTaskEvidenceDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly onboarding: OnboardingSummary }> {
    const result = await this.onboarding.recordTaskEvidence(
      this.requireUlid(id), this.requireVersion(ifMatch), this.requireKey(key),
      {
        taskCode: this.requireHumanTask(taskCode), evidenceId: body.evidenceId,
        ...(body.orgPositionId === undefined ? {} : { orgPositionId: body.orgPositionId }),
      },
    );
    this.setVersion(response, result.onboarding.version);
    await this.auditSuccess('onboarding.task.record_evidence', result.onboarding, 'R2', {
      taskCode,
    });
    return result;
  }

  @Post(':id/sync-contract')
  @HttpCode(200)
  @RequiredScopes('erp:onboarding:contract:attest')
  async syncContract(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly onboarding: OnboardingSummary }> {
    const result = await this.onboarding.syncContractEvidence(
      this.requireUlid(id), this.requireVersion(ifMatch), this.requireKey(key),
    );
    this.setVersion(response, result.onboarding.version);
    await this.auditSuccess('onboarding.contract.sync', result.onboarding, 'R1');
    return result;
  }

  @Post(':id/complete')
  @HttpCode(200)
  @RequiredScopes('erp:onboarding:complete')
  async complete(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly onboarding: OnboardingSummary }> {
    const result = await this.onboarding.complete(
      this.requireUlid(id), this.requireVersion(ifMatch), this.requireKey(key),
    );
    this.setVersion(response, result.onboarding.version);
    await this.auditSuccess('onboarding.instance.complete', result.onboarding, 'R3');
    return result;
  }

  private requireHumanTask(value: string): OnboardingTaskCode {
    if (!HUMAN_TASKS.has(value as OnboardingTaskCode)) throw new BadRequestException({
      code: 'ONBOARDING_TASK_CODE_INVALID', message: '该任务不能通过人工接口声明完成',
    });
    return value as OnboardingTaskCode;
  }

  private requireUlid(value: string): string {
    if (!ULID_PATTERN.test(value)) throw new BadRequestException({
      code: 'ONBOARDING_ID_INVALID', message: '入职资源标识必须为严格 ULID',
    });
    return value;
  }

  private requireKey(value: string | undefined): string {
    if (value === undefined || value.length === 0) throw new BadRequestException({
      code: 'IDEMPOTENCY_KEY_REQUIRED', message: '写接口必须提供 Idempotency-Key',
    });
    return value;
  }

  private requireVersion(value: string | undefined): number {
    const match = IF_MATCH_PATTERN.exec(value ?? '');
    const version = Number(match?.[1]);
    if (match?.[1] === undefined || !Number.isSafeInteger(version)) throw new BadRequestException({
      code: 'ONBOARDING_IF_MATCH_REQUIRED', message: '写接口必须提供强 If-Match 版本，例如 "3"',
    });
    return version;
  }

  private setVersion(response: Response, version: number): void {
    response.setHeader('ETag', `"${version}"`);
  }

  private async auditSuccess(
    action: string,
    instance: OnboardingSummary,
    riskLevel: 'R1' | 'R2' | 'R3',
    metadata: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    await this.audit.record({
      action, resourceType: 'onboarding_instance', resourceId: instance.id,
      riskLevel, outcome: 'success',
      metadata: { status: instance.status, version: instance.version, ...metadata },
    });
  }
}
