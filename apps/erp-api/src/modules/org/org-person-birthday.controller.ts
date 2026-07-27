import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { AuditService } from '../../core/audit/audit.service.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import { AttestPersonBirthdayDto } from './application/org-person-birthday.dto.js';
import {
  OrgPersonBirthdayService,
  type PersonBirthdayAttestationSummary,
} from './application/org-person-birthday.service.js';

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const IF_MATCH_PATTERN = /^"([1-9][0-9]*)"$/;

/** 身份服务专用生日证明入口；响应、审计和事件均不返回生日月日。 */
@Controller('org/persons')
export class OrgPersonBirthdayController {
  constructor(
    private readonly birthdays: OrgPersonBirthdayService,
    private readonly audit: AuditService,
  ) {}

  @Post(':id/birthday-attestations')
  @HttpCode(200)
  @RequiredScopes('erp:org:person:birthday:attest')
  async attest(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: AttestPersonBirthdayDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly attestation: PersonBirthdayAttestationSummary }> {
    const result = await this.birthdays.attest(
      this.id(id),
      this.version(ifMatch),
      this.key(key),
      body,
    );
    response.setHeader('ETag', `"${result.attestation.version}"`);
    await this.audit.record({
      action: 'org.person.birthday.attest',
      resourceType: 'org_person',
      resourceId: result.attestation.personId,
      riskLevel: 'R2',
      outcome: 'success',
      metadata: {
        birthdayAttested: true,
        version: result.attestation.version,
      },
    });
    return result;
  }

  private id(value: string): string {
    if (!ULID_PATTERN.test(value)) throw new BadRequestException({
      code: 'ORG_INVALID_ID',
      message: '资源标识必须为严格 ULID',
    });
    return value;
  }

  private version(value: string | undefined): number {
    const match = IF_MATCH_PATTERN.exec(value ?? '');
    const version = Number(match?.[1]);
    if (match?.[1] === undefined || !Number.isSafeInteger(version)) {
      throw new BadRequestException({
        code: 'ORG_IF_MATCH_REQUIRED',
        message: '更新接口必须提供强 If-Match 版本',
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
}
