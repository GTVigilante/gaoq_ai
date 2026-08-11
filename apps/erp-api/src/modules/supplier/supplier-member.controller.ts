import {
  BadRequestException, Body, Controller, Get, Headers, Logger, Param, Post, Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { AuditService } from '../../core/audit/audit.service.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import { CreateSupplierMemberDto, RevokeSupplierMemberDto } from './application/supplier-member.dto.js';
import { SupplierMemberService } from './application/supplier-member.service.js';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const KEY = /^[A-Za-z0-9._:-]{8,128}$/u;
const ETAG = /^"([1-9][0-9]*)"$/u;
type WriteResult = { readonly member: { readonly id: string; readonly version: number; readonly status: string } };

@Controller('suppliers')
export class SupplierMemberController {
  private readonly logger = new Logger(SupplierMemberController.name);
  constructor(
    private readonly members: SupplierMemberService,
    private readonly audit: AuditService,
  ) {}

  @Post(':id/members')
  @RequiredScopes('erp:supplier:member:manage')
  create(
    @Param('id') id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: CreateSupplierMemberDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const supplierId = this.id(id); const idempotencyKey = this.key(key);
    return this.write(response, 'supplier.member.authorize', supplierId, undefined,
      () => this.members.create(supplierId, idempotencyKey, body));
  }

  @Get(':id/members')
  @RequiredScopes('erp:supplier:member:read')
  list(@Param('id') id: string) { return this.members.list(this.id(id)); }

  @Post(':id/members/:memberId/revoke')
  @RequiredScopes('erp:supplier:member:manage')
  revoke(
    @Param('id') id: string,
    @Param('memberId') memberId: string,
    @Headers('if-match') version: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: RevokeSupplierMemberDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const supplierId = this.id(id); const relationId = this.id(memberId);
    const expected = this.version(version); const idempotencyKey = this.key(key);
    return this.write(response, 'supplier.member.revoke', relationId, expected,
      () => this.members.revoke(supplierId, relationId, expected, idempotencyKey, body));
  }

  private async write(
    response: Response,
    action: string,
    resourceId: string,
    expectedVersion: number | undefined,
    operation: () => Promise<WriteResult>,
  ) {
    let result: WriteResult;
    try { result = await operation(); } catch (error) {
      try {
        await this.audit.record({
          action, resourceType: 'supplier_member', resourceId, riskLevel: 'R2',
          outcome: 'failure', metadata: expectedVersion === undefined ? {} : { expectedVersion },
        });
      } catch { this.logger.error({ code: 'SUPPLIER_MEMBER_FAILURE_AUDIT_FAILED', action, resourceId }); }
      throw error;
    }
    response.setHeader('ETag', `"${result.member.version}"`);
    try {
      await this.audit.record({
        action, resourceType: 'supplier_member', resourceId: result.member.id,
        riskLevel: 'R2', outcome: 'success',
        metadata: { version: result.member.version, status: result.member.status },
      });
    } catch {
      this.logger.error({ code: 'SUPPLIER_MEMBER_COMMITTED_AUDIT_FAILED', action, resourceId: result.member.id });
    }
    return result;
  }

  private id(value: unknown): string {
    if (typeof value !== 'string' || !ULID.test(value)) {
      throw new BadRequestException({ code: 'SUPPLIER_MEMBER_ID_INVALID', message: '资源标识必须为严格 ULID' });
    }
    return value;
  }
  private key(value: unknown): string {
    if (typeof value !== 'string' || !KEY.test(value)) {
      throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: '写接口必须提供规范幂等键' });
    }
    return value;
  }
  private version(value: unknown): number {
    const match = typeof value === 'string' ? ETAG.exec(value) : null;
    const parsed = Number(match?.[1]);
    if (match === null || !Number.isSafeInteger(parsed) || parsed >= Number.MAX_SAFE_INTEGER) {
      throw new BadRequestException({ code: 'SUPPLIER_MEMBER_IF_MATCH_REQUIRED', message: '写接口必须提供强 If-Match' });
    }
    return parsed;
  }
}
