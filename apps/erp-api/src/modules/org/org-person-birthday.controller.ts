import {
  BadRequestException,
  Body,
  Controller,
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
import {
  attestPersonBirthdayRequestSchema,
  type AttestPersonBirthdayDto,
} from './application/org-person-birthday.dto.js';
import {
  OrgPersonBirthdayService,
  type PersonBirthdayAttestationSummary,
} from './application/org-person-birthday.service.js';

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const IF_MATCH_PATTERN = /^"([1-9][0-9]*)"$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/** 身份服务专用生日证明入口；响应、审计和事件均不返回生日月日。 */
@Controller('org/persons')
export class OrgPersonBirthdayController {
  private readonly logger = new Logger(OrgPersonBirthdayController.name);

  constructor(
    private readonly birthdays: OrgPersonBirthdayService,
    private readonly audit: AuditService,
  ) {}

  @Post(':id/birthday-attestations')
  @HttpCode(200)
  @RequiredScopes('erp:org:person:birthday:attest')
  async attest(
    @Param('id') id: unknown,
    @Headers('if-match') ifMatch: unknown,
    @Headers('idempotency-key') key: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly attestation: PersonBirthdayAttestationSummary }> {
    const personId = this.id(id);
    const expectedVersion = this.version(ifMatch);
    const idempotencyKey = this.key(key);
    const request = this.body(body);
    let result;
    try {
      result = await this.birthdays.attest(
        personId,
        expectedVersion,
        idempotencyKey,
        request,
      );
    } catch (error) {
      try {
        await this.auditAttestation(personId, expectedVersion, 'failure');
      } catch {
        this.logger.error({
          code: 'ORG_PERSON_BIRTHDAY_ATTEST_FAILURE_AUDIT_FAILED',
          personId,
        });
      }
      throw error;
    }
    response.setHeader('ETag', `"${result.attestation.version}"`);
    try {
      await this.auditAttestation(
        result.attestation.personId,
        result.attestation.version,
        'success',
      );
    } catch {
      this.logger.error({
        code: 'ORG_PERSON_BIRTHDAY_ATTEST_AUDIT_AFTER_COMMIT_FAILED',
        personId: result.attestation.personId,
      });
    }
    return result;
  }

  private id(value: unknown): string {
    if (typeof value !== 'string' || !ULID_PATTERN.test(value)) throw new BadRequestException({
      code: 'ORG_INVALID_ID',
      message: '资源标识必须为严格 ULID',
    });
    return value;
  }

  private version(value: unknown): number {
    const match = typeof value === 'string' ? IF_MATCH_PATTERN.exec(value) : null;
    const version = Number(match?.[1]);
    if (
      match?.[1] === undefined ||
      !Number.isSafeInteger(version) ||
      version >= Number.MAX_SAFE_INTEGER
    ) {
      throw new BadRequestException({
        code: 'ORG_IF_MATCH_REQUIRED',
        message: '更新接口必须提供强 If-Match 版本',
      });
    }
    return version;
  }

  private key(value: unknown): string {
    if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: '写接口必须提供合法 Idempotency-Key',
      });
    }
    return value;
  }

  private body(value: unknown): AttestPersonBirthdayDto {
    const parsed = attestPersonBirthdayRequestSchema.safeParse(value);
    if (!parsed.success) throw new BadRequestException({
      code: 'ORG_PERSON_BIRTHDAY_REQUEST_INVALID',
      message: '生日证明请求结构无效',
    });
    return Object.freeze(parsed.data);
  }

  private async auditAttestation(
    personId: string,
    version: number,
    outcome: 'success' | 'failure',
  ): Promise<void> {
    await this.audit.record({
      action: 'org.person.birthday.attest',
      resourceType: 'org_person',
      resourceId: personId,
      riskLevel: 'R2',
      outcome,
      metadata: {
        ...(outcome === 'success' ? { birthdayAttested: true } : {}),
        version,
      },
    });
  }
}
