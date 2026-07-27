import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Logger,
  Param,
  Patch,
  Post,
  Res,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTraceId } from '@gaoq/shared-utils';
import type { Response } from 'express';
import type { AppEnvironment } from '../../config/environment.js';
import { AuditService } from '../../core/audit/audit.service.js';
import type { AuditRecordInput } from '../../core/audit/audit.types.js';
import { PublicRoute, RawResponse } from '../../core/http/public-route.decorator.js';
import type { ErpRequest } from '../../core/http/request-context.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import { MarketingCmsService } from './marketing-cms.service.js';
import { MarketingPublicProtectionService } from './marketing-public-protection.service.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/u;
const IF_MATCH = /^"([1-9][0-9]*)"$/u;

@Controller('marketing-cms')
export class MarketingCmsController {
  private readonly logger = new Logger(MarketingCmsController.name);

  constructor(private readonly cms: MarketingCmsService, private readonly audit: AuditService) {}

  @Post('contents')
  @RequiredScopes('erp:marketing:content:create')
  async create(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.cms.create(requiredKey(key), body);
    setVersionHeader(response, result);
    await this.auditContent('marketing.content.create', result.content);
    return result;
  }

  @Get('contents')
  @RequiredScopes('erp:marketing:content:read')
  async list() {
    const result = await this.cms.list();
    await this.audit.record({
      action: 'marketing.content.list',
      resourceType: 'marketing_content_list',
      resourceId: 'all',
      riskLevel: 'R0',
      outcome: 'success',
      metadata: { count: result.items.length },
    });
    return result;
  }

  @Get('contents/:id')
  @RequiredScopes('erp:marketing:content:read')
  async get(@Param('id') id: string) {
    const resourceId = requiredId(id);
    const result = await this.cms.get(resourceId);
    await this.audit.record({
      action: 'marketing.content.read',
      resourceType: 'marketing_content',
      resourceId,
      riskLevel: 'R0',
      outcome: 'success',
      metadata: {
        status: String(result.status),
        revision: Number(result.revision),
      },
    });
    return result;
  }

  @Get('contents/:id/revisions')
  @RequiredScopes('erp:marketing:content:read')
  async revisions(@Param('id') id: string) {
    const resourceId = requiredId(id);
    const result = await this.cms.revisionsFor(resourceId);
    await this.audit.record({
      action: 'marketing.content.revisions.read',
      resourceType: 'marketing_content',
      resourceId,
      riskLevel: 'R0',
      outcome: 'success',
      metadata: { count: result.items.length },
    });
    return result;
  }

  @Patch('contents/:id')
  @RequiredScopes('erp:marketing:content:update')
  async update(
    @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined, @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.cms.update(requiredId(id), requiredVersion(ifMatch), requiredKey(key), body);
    setVersionHeader(response, result);
    await this.auditContent('marketing.content.update', result.content);
    return result;
  }

  @Post('contents/:id/submit')
  @HttpCode(200)
  @RequiredScopes('erp:marketing:content:submit')
  submit(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.runTransition(id, ifMatch, key, 'submit', 'in_review', response);
  }

  @Post('contents/:id/approve')
  @HttpCode(200)
  @RequiredScopes('erp:marketing:content:approve')
  approve(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.runTransition(id, ifMatch, key, 'approve', 'approved', response);
  }

  @Post('contents/:id/publish')
  @HttpCode(200)
  @RequiredScopes('erp:marketing:content:publish')
  publish(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.runTransition(id, ifMatch, key, 'publish', 'published', response);
  }

  @Post('contents/:id/schedule')
  @HttpCode(200)
  @RequiredScopes('erp:marketing:content:publish')
  async schedule(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const scheduledAt = readString(body, 'scheduledAt');
    const result = await this.cms.schedule(
      requiredId(id), requiredVersion(ifMatch), requiredKey(key), scheduledAt,
    );
    setVersionHeader(response, result);
    await this.auditContent('marketing.content.schedule', result.content);
    return result;
  }

  @Post('contents/:id/withdraw')
  @HttpCode(200)
  @RequiredScopes('erp:marketing:content:publish')
  withdraw(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.runTransition(id, ifMatch, key, 'withdraw', 'archived', response);
  }

  @Post('contents/:id/restore')
  @HttpCode(200)
  @RequiredScopes('erp:marketing:content:update')
  restore(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.runTransition(id, ifMatch, key, 'restore', 'draft', response);
  }

  @Post('contents/:id/rollback')
  @HttpCode(200)
  @RequiredScopes('erp:marketing:content:rollback')
  async rollback(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const revision = readPositiveInteger(body, 'revision');
    const result = await this.cms.rollback(
      requiredId(id), revision, requiredVersion(ifMatch), requiredKey(key),
    );
    setVersionHeader(response, result);
    await this.auditContent('marketing.content.rollback', result.content);
    return result;
  }

  @Get('leads')
  @RequiredScopes('erp:marketing:lead:read')
  async leads() {
    const result = await this.cms.listLeads();
    await this.audit.record({
      action: 'marketing.lead.list',
      resourceType: 'marketing_lead_list',
      resourceId: 'all',
      riskLevel: 'R1',
      outcome: 'success',
      metadata: { count: result.items.length },
    });
    return result;
  }

  @Get('leads-export.csv')
  @RawResponse()
  @RequiredScopes('erp:marketing:lead:export')
  async exportLeads(@Res() response: Response) {
    const csv = await this.cms.exportLeadsCsv();
    await this.audit.record({
      action: 'marketing.lead.export', resourceType: 'marketing_lead_list',
      resourceId: 'all', riskLevel: 'R2', outcome: 'success',
      metadata: { format: 'csv' },
    });
    response.setHeader('content-type', 'text/csv; charset=utf-8');
    response.setHeader('content-disposition', 'attachment; filename="marketing-leads.csv"');
    response.send(csv);
  }

  @Patch('leads/:id/status')
  @RequiredScopes('erp:marketing:lead:update')
  async updateLead(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const status = readString(body, 'status');
    const resourceId = requiredId(id);
    const result = await this.cms.updateLeadStatus(
      requiredKey(key), resourceId, status, requiredVersion(ifMatch),
    );
    setVersionHeader(response, result);
    await this.auditAfterCommit({
      action: 'marketing.lead.status.update', resourceType: 'marketing_lead',
      resourceId, riskLevel: 'R1', outcome: 'success',
      metadata: { status, version: Number(result.version) },
    });
    return result;
  }

  @Patch('leads/:id/assignee')
  @RequiredScopes('erp:marketing:lead:update')
  async assignLead(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const resourceId = requiredId(id);
    const assigneeId = readString(body, 'assigneeId');
    const result = await this.cms.assignLead(
      requiredKey(key), resourceId, assigneeId, requiredVersion(ifMatch),
    );
    setVersionHeader(response, result);
    await this.auditAfterCommit({
      action: 'marketing.lead.assignee.update',
      resourceType: 'marketing_lead',
      resourceId,
      riskLevel: 'R1',
      outcome: 'success',
      metadata: { assigneeId, version: Number(result.version) },
    });
    return result;
  }

  @Post('leads/:id/notes')
  @RequiredScopes('erp:marketing:lead:update')
  async addLeadNote(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const resourceId = requiredId(id);
    const result = await this.cms.addLeadNote(
      requiredKey(key), resourceId, readString(body, 'body'), requiredVersion(ifMatch),
    );
    setVersionHeader(response, result);
    await this.auditAfterCommit({
      action: 'marketing.lead.note.add',
      resourceType: 'marketing_lead',
      resourceId,
      riskLevel: 'R1',
      outcome: 'success',
      metadata: { version: Number(result.version) },
    });
    return result;
  }

  @Post('side-effects/:id/replay')
  @HttpCode(200)
  @RequiredScopes('erp:marketing:operations:replay')
  async replaySideEffect(
    @Param('id') id: string,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    const resourceId = requiredId(id);
    const result = await this.cms.replaySideEffect(requiredKey(key), resourceId);
    await this.auditAfterCommit({
      action: 'marketing.side_effect.replay',
      resourceType: 'marketing_side_effect',
      resourceId,
      riskLevel: 'R2',
      outcome: 'success',
      metadata: { kind: String(result.kind), status: String(result.status) },
    });
    return result;
  }

  @Get('side-effects/:id')
  @RequiredScopes('erp:marketing:operations:read')
  async getSideEffect(@Param('id') id: string) {
    const resourceId = requiredId(id);
    const result = await this.cms.getSideEffectStatus(resourceId);
    await this.audit.record({
      action: 'marketing.side_effect.read',
      resourceType: 'marketing_side_effect',
      resourceId,
      riskLevel: 'R0',
      outcome: 'success',
      metadata: {
        kind: String(result.kind),
        status: String(result.status),
      },
    });
    return result;
  }

  @Post('media/uploads')
  @RequiredScopes('erp:marketing:media:create')
  async createMedia(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.cms.createMediaUpload(requiredKey(key), body);
    setVersionHeader(response, result);
    await this.auditAfterCommit({
      action: 'marketing.media.upload.create',
      resourceType: 'marketing_media',
      resourceId: String(result.id),
      riskLevel: 'R1',
      outcome: 'success',
      metadata: { version: Number(result.version) },
    });
    return result;
  }

  @Post('media/:id/verify')
  @HttpCode(200)
  @RequiredScopes('erp:marketing:media:create')
  async verifyMedia(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const resourceId = requiredId(id);
    const result = await this.cms.verifyMedia(
      requiredKey(key), resourceId, requiredVersion(ifMatch),
    );
    setVersionHeader(response, result);
    await this.auditAfterCommit({
      action: 'marketing.media.upload.verify',
      resourceType: 'marketing_media',
      resourceId,
      riskLevel: 'R1',
      outcome: 'success',
      metadata: { status: String(result.status), version: Number(result.version) },
    });
    return result;
  }

  @Get('media')
  @RequiredScopes('erp:marketing:media:read')
  async media() {
    const result = await this.cms.listMedia();
    await this.audit.record({
      action: 'marketing.media.list',
      resourceType: 'marketing_media_list',
      resourceId: 'all',
      riskLevel: 'R0',
      outcome: 'success',
      metadata: { count: result.items.length },
    });
    return result;
  }

  @Post('contents/:id/ai-drafts')
  @RequiredScopes('erp:marketing:ai:generate')
  async aiDraft(
    @Param('id') id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    const resourceId = requiredId(id);
    const result = await this.cms.generateAiDraft(requiredKey(key), resourceId, body);
    await this.auditAfterCommit({
      action: 'marketing.ai.draft.generate', resourceType: 'marketing_content',
      resourceId, riskLevel: 'R1', outcome: 'success',
      metadata: { generationId: String(result.id), status: String(result.status) },
    });
    return result;
  }

  @Post('ai-drafts/:id/review')
  @HttpCode(200)
  @RequiredScopes('erp:marketing:ai:review')
  async reviewAiDraft(
    @Param('id') id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    const decision = readString(body, 'decision');
    if (decision !== 'accepted' && decision !== 'rejected') throw invalidBody();
    const resourceId = requiredId(id);
    const result = await this.cms.reviewAiDraft(requiredKey(key), resourceId, decision);
    await this.auditAfterCommit({
      action: 'marketing.ai.draft.review', resourceType: 'marketing_ai_generation',
      resourceId, riskLevel: 'R1', outcome: 'success',
      metadata: { decision, contentId: String(result.contentId) },
    });
    return result;
  }

  private async auditContent(action: string, content: Readonly<Record<string, unknown>>) {
    await this.auditAfterCommit({
      action, resourceType: 'marketing_content', resourceId: String(content.id),
      riskLevel: action.endsWith('publish') ? 'R2' : 'R1', outcome: 'success',
      metadata: { status: String(content.status), revision: Number(content.revision) },
    });
  }

  private async auditAfterCommit(input: AuditRecordInput): Promise<void> {
    try {
      await this.audit.record(input);
    } catch {
      this.logger.error({
        code: 'MARKETING_AUDIT_AFTER_COMMIT_FAILED',
        action: input.action,
        resourceId: input.resourceId,
      });
    }
  }

  private async runTransition(
    id: string,
    ifMatch: string | undefined,
    key: string | undefined,
    action: string,
    target: 'draft' | 'in_review' | 'approved' | 'published' | 'archived',
    response: Response,
  ) {
    const result = await this.cms.transition(
      requiredId(id), requiredVersion(ifMatch), requiredKey(key), target,
    );
    setVersionHeader(response, result);
    await this.auditContent(`marketing.content.${action}`, result.content);
    return result;
  }

}

function requiredId(value: string): string {
  if (!ID.test(value)) {
    throw new BadRequestException({ code: 'CMS_ID_INVALID', message: '内容标识无效' });
  }
  return value;
}

function requiredKey(value: string | undefined): string {
  if (value === undefined || !IDEMPOTENCY_KEY.test(value)) {
    throw new BadRequestException({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: '写接口必须提供 8..128 位合法 Idempotency-Key',
    });
  }
  return value;
}

function requiredVersion(value: string | undefined): number {
  const match = IF_MATCH.exec(value ?? '');
  if (match?.[1] === undefined) {
    throw new BadRequestException({
      code: 'CMS_IF_MATCH_REQUIRED',
      message: '写接口必须提供强 If-Match',
    });
  }
  return Number(match[1]);
}

function setVersionHeader(
  response: Response,
  result: { readonly content?: unknown; readonly version?: unknown },
): void {
  const content = result.content;
  const version =
    typeof content === 'object' && content !== null && !Array.isArray(content)
      ? (content as Readonly<Record<string, unknown>>).version
      : result.version;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new Error('MARKETING_VERSION_MISSING');
  }
  response.setHeader('ETag', `"${String(version)}"`);
}

function readPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidBody();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1 ||
    typeof record[field] !== 'number' ||
    !Number.isSafeInteger(record[field]) ||
    record[field] < 1
  ) throw invalidBody();
  return record[field];
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidBody();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || typeof record[field] !== 'string') throw invalidBody();
  return record[field];
}

function invalidBody(): BadRequestException {
  return new BadRequestException({ code: 'CMS_REQUEST_INVALID', message: '请求参数无效' });
}

@Controller('marketing/public')
@PublicRoute()
export class MarketingPublicController {
  private readonly logger = new Logger(MarketingPublicController.name);

  constructor(
    private readonly cms: MarketingCmsService,
    private readonly protection: MarketingPublicProtectionService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<AppEnvironment, true>,
  ) {}

  @Get(':locale/contents/:type')
  list(@Param('locale') locale: string, @Param('type') type: string) {
    return this.cms.publicList(locale, type);
  }

  @Get(':locale/contents/:type/:slug')
  get(
    @Param('locale') locale: string, @Param('type') type: string, @Param('slug') slug: string,
  ) {
    return this.cms.publicContent(locale, type, slug);
  }

  @Post('leads')
  async submitLead(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
    @Req() request: ErpRequest,
  ) {
    const idempotencyKey = requiredKey(key);
    const { captchaToken, lead } = publicLeadRequest(body);
    await this.protection.assertAllowed(request.ip ?? request.socket.remoteAddress ?? 'unknown', captchaToken);
    const result = await this.cms.submitLead(idempotencyKey, lead);
    try {
      await this.audit.recordSystem(
        this.config.get('MARKETING_PUBLIC_TENANT_ID', { infer: true }),
        {
          traceId: request.traceId ?? createTraceId(),
          action: 'marketing.lead.submit',
          resourceType: 'marketing_lead',
          resourceId: result.leadId,
          riskLevel: 'R1',
          outcome: 'success',
          metadata: { duplicate: result.duplicate },
        },
      );
    } catch {
      this.logger.error({
        code: 'MARKETING_AUDIT_AFTER_COMMIT_FAILED',
        action: 'marketing.lead.submit',
        resourceId: result.leadId,
      });
    }
    return result;
  }
}

function publicLeadRequest(value: unknown): {
  readonly captchaToken: string;
  readonly lead: Record<string, unknown>;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidBody();
  const record = value as Record<string, unknown>;
  if (
    typeof record.captchaToken !== 'string' ||
    record.captchaToken.length < 16 ||
    record.captchaToken.length > 4096
  ) throw invalidBody();
  const { captchaToken, ...lead } = record;
  return { captchaToken, lead };
}
