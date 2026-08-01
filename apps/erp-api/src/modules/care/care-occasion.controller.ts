import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  Put,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { AuditService } from '../../core/audit/audit.service.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import {
  CareOccasionApplicationService,
  type CareOccasionPreferenceSummary,
  type MyCareOccasionSummary,
} from './application/care-occasion-application.service.js';
import { UpdateMyCareOccasionPreferenceDto } from './application/care-occasion.dto.js';

const IF_MATCH = /^"([1-9][0-9]*)"$/;

@Controller('care/occasion-preferences')
export class CareOccasionController {
  constructor(
    private readonly occasions: CareOccasionApplicationService,
    private readonly audit: AuditService,
  ) {}

  @Get('me')
  @RequiredScopes('erp:care:occasion:preference:read')
  async getMine(): Promise<MyCareOccasionSummary> {
    return this.occasions.getMySummary();
  }

  @Post('me')
  @RequiredScopes('erp:care:occasion:preference:write')
  async createMine(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: UpdateMyCareOccasionPreferenceDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly preference: CareOccasionPreferenceSummary }> {
    const result = await this.occasions.createMyPreference(this.key(key), body);
    this.etag(response, result.preference.version);
    await this.auditPreference('care.occasion.preference.create', result.preference);
    return result;
  }

  @Put('me')
  @HttpCode(200)
  @RequiredScopes('erp:care:occasion:preference:write')
  async updateMine(
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: UpdateMyCareOccasionPreferenceDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly preference: CareOccasionPreferenceSummary }> {
    const result = await this.occasions.updateMyPreference(
      this.version(ifMatch),
      this.key(key),
      body,
    );
    this.etag(response, result.preference.version);
    await this.auditPreference('care.occasion.preference.update', result.preference);
    return result;
  }

  @Post('me/unsubscribe')
  @HttpCode(200)
  @RequiredScopes('erp:care:occasion:preference:write')
  async unsubscribeMine(
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly preference: CareOccasionPreferenceSummary }> {
    const result = await this.occasions.unsubscribeMyPreference(
      this.version(ifMatch),
      this.key(key),
    );
    this.etag(response, result.preference.version);
    await this.auditPreference('care.occasion.preference.unsubscribe', result.preference);
    return result;
  }

  private version(value: string | undefined): number {
    const match = IF_MATCH.exec(value ?? '');
    const version = Number(match?.[1]);
    if (match?.[1] === undefined || !Number.isSafeInteger(version)) {
      throw new BadRequestException({
        code: 'CARE_IF_MATCH_REQUIRED',
        message: '更新接口必须提供强 If-Match',
      });
    }
    return version;
  }

  private key(value: string | undefined): string {
    if (value === undefined || value.length === 0) throw new BadRequestException({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: '写接口必须提供 Idempotency-Key',
    });
    return value;
  }

  private etag(response: Response, version: number): void {
    response.setHeader('ETag', `"${version}"`);
  }

  private async auditPreference(
    action: string,
    preference: CareOccasionPreferenceSummary,
  ): Promise<void> {
    await this.audit.record({
      action,
      resourceType: 'care_occasion_preference',
      resourceId: preference.id,
      riskLevel: 'R1',
      outcome: 'success',
      metadata: {
        birthdayEnabled: preference.birthdayEnabled,
        anniversaryEnabled: preference.anniversaryEnabled,
        unsubscribed: preference.unsubscribed,
        version: preference.version,
      },
    });
  }
}
