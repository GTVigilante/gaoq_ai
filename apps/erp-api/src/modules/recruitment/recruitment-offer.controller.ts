import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Logger,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { AuditService } from '../../core/audit/audit.service.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import { CreateRecruitmentOfferDto } from './application/recruitment-offer.dto.js';
import {
  RecruitmentOfferService,
  type RecruitmentOfferSummary,
} from './application/recruitment-offer.service.js';

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const IF_MATCH_PATTERN = /^"([1-9][0-9]*)"$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/** Offer REST 边界；L4 条款只进加密应用服务，不出现在响应、审计或事件。 */
@Controller('recruitment')
export class RecruitmentOfferController {
  private readonly logger = new Logger(RecruitmentOfferController.name);

  constructor(
    private readonly offers: RecruitmentOfferService,
    private readonly audit: AuditService,
  ) {}

  @Post('applications/:applicationId/offers')
  @RequiredScopes('erp:recruitment:offer:create')
  async create(
    @Param('applicationId') applicationId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: CreateRecruitmentOfferDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly offer: RecruitmentOfferSummary }> {
    const resourceId = this.requireUlid(applicationId);
    const expectedVersion = this.requireVersion(ifMatch);
    const idempotencyKey = this.requireKey(key);
    const result = await this.executeWrite(
      'recruitment.offer.create',
      'recruitment_application',
      resourceId,
      expectedVersion,
      () => this.offers.create(resourceId, expectedVersion, idempotencyKey, body),
    );
    this.setVersion(response, result.offer.version);
    await this.auditSuccess('recruitment.offer.create', result.offer);
    return result;
  }

  @Get('offers/:id')
  @RequiredScopes('erp:recruitment:offer:read')
  async get(
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<RecruitmentOfferSummary> {
    const offer = await this.offers.get(this.requireUlid(id));
    this.setVersion(response, offer.version);
    return offer;
  }

  @Post('offers/:id/submit')
  @HttpCode(200)
  @RequiredScopes('erp:recruitment:offer:submit')
  async submit(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly offer: RecruitmentOfferSummary }> {
    const resourceId = this.requireUlid(id);
    const expectedVersion = this.requireVersion(ifMatch);
    const idempotencyKey = this.requireKey(key);
    this.requireEmptyBody(body);
    const result = await this.executeWrite(
      'recruitment.offer.submit',
      'recruitment_offer',
      resourceId,
      expectedVersion,
      () => this.offers.submit(resourceId, expectedVersion, idempotencyKey),
    );
    this.setVersion(response, result.offer.version);
    await this.auditSuccess('recruitment.offer.submit', result.offer);
    return result;
  }

  @Post('offers/:id/sync-approval')
  @HttpCode(200)
  @RequiredScopes('erp:recruitment:offer:sync_approval')
  async syncApproval(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly offer: RecruitmentOfferSummary }> {
    const resourceId = this.requireUlid(id);
    const expectedVersion = this.requireVersion(ifMatch);
    const idempotencyKey = this.requireKey(key);
    this.requireEmptyBody(body);
    const result = await this.executeWrite(
      'recruitment.offer.sync_approval',
      'recruitment_offer',
      resourceId,
      expectedVersion,
      () => this.offers.syncApproval(resourceId, expectedVersion, idempotencyKey),
    );
    this.setVersion(response, result.offer.version);
    await this.auditSuccess('recruitment.offer.sync_approval', result.offer);
    return result;
  }

  @Post('offers/:id/send')
  @HttpCode(202)
  @RequiredScopes('erp:recruitment:offer:send')
  async requestSend(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly offer: RecruitmentOfferSummary }> {
    const resourceId = this.requireUlid(id);
    const expectedVersion = this.requireVersion(ifMatch);
    const idempotencyKey = this.requireKey(key);
    this.requireEmptyBody(body);
    const result = await this.executeWrite(
      'recruitment.offer.request_send',
      'recruitment_offer',
      resourceId,
      expectedVersion,
      () => this.offers.requestSend(resourceId, expectedVersion, idempotencyKey),
    );
    this.setVersion(response, result.offer.version);
    await this.auditSuccess('recruitment.offer.request_send', result.offer);
    return result;
  }

  private requireKey(value: unknown): string {
    if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
      throw new BadRequestException({
      code: 'IDEMPOTENCY_KEY_REQUIRED', message: '写接口必须提供 Idempotency-Key',
      });
    }
    return value;
  }

  private requireVersion(value: unknown): number {
    const match = typeof value === 'string' ? IF_MATCH_PATTERN.exec(value) : null;
    const version = Number(match?.[1]);
    if (
      match?.[1] === undefined ||
      !Number.isSafeInteger(version) ||
      version >= Number.MAX_SAFE_INTEGER
    ) {
      throw new BadRequestException({
        code: 'RECRUITMENT_IF_MATCH_REQUIRED',
        message: '写接口必须提供强 If-Match 版本，例如 "3"',
      });
    }
    return version;
  }

  private requireUlid(value: unknown): string {
    if (typeof value !== 'string' || !ULID_PATTERN.test(value)) throw new BadRequestException({
      code: 'RECRUITMENT_INVALID_ID', message: '招聘资源标识必须为严格 ULID',
    });
    return value;
  }

  private requireEmptyBody(value: unknown): void {
    if (value === undefined) return;
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).length !== 0
    ) {
      throw new BadRequestException({
        code: 'RECRUITMENT_OFFER_BODY_FORBIDDEN',
        message: '该 Offer 写接口不接受请求正文',
      });
    }
  }

  private setVersion(response: Response, version: number): void {
    response.setHeader('ETag', `"${version}"`);
  }

  private async executeWrite<T>(
    action: string,
    resourceType: 'recruitment_application' | 'recruitment_offer',
    resourceId: string,
    expectedVersion: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      try {
        await this.audit.record({
          action,
          resourceType,
          resourceId,
          riskLevel: 'R2',
          outcome: 'failure',
          metadata: { expectedVersion },
        });
      } catch {
        this.logger.error({
          code: 'RECRUITMENT_OFFER_FAILURE_AUDIT_FAILED',
          action,
          resourceId,
        });
      }
      throw error;
    }
  }

  private async auditSuccess(action: string, offer: RecruitmentOfferSummary): Promise<void> {
    try {
      await this.audit.record({
        action, resourceType: 'recruitment_offer', resourceId: offer.id,
        riskLevel: 'R2', outcome: 'success',
        metadata: { version: offer.version, status: offer.status },
      });
    } catch {
      this.logger.error({
        code: 'RECRUITMENT_OFFER_AUDIT_AFTER_COMMIT_FAILED',
        action,
        resourceId: offer.id,
      });
    }
  }
}
