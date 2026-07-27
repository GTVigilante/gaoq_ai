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
import type { Request, Response } from 'express';
import { AuditService } from '../../core/audit/audit.service.js';
import { PublicRoute, RawResponse } from '../../core/http/public-route.decorator.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import { MarketingCmsService } from './marketing-cms.service.js';
import { MarketingPublicProtectionService } from './marketing-public-protection.service.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/u;
const IF_MATCH = /^"([1-9][0-9]*)"$/u;

@Controller('marketing-cms')
export class MarketingCmsController {
  private readonly logger = new Logger(MarketingCmsController.name);

  constructor(private readonly cms: MarketingCmsService, private readonly audit: AuditService) {}

  @Post('contents')
  @RequiredScopes('erp:marketing:content:create')
  async create(@Headers('idempotency-key') key: string | undefined, @Body() body: unknown) {
    const result = await this.cms.create(this.key(key), body);
    await this.auditContent('marketing.content.create', result.content);
    return result;
  }

  @Get('contents')
  @RequiredScopes('erp:marketing:content:read')
  list() { return this.cms.list(); }

  @Get('contents/:id')
  @RequiredScopes('erp:marketing:content:read')
  get(@Param('id') id: string) { return this.cms.get(this.id(id)); }

  @Get('contents/:id/revisions')
  @RequiredScopes('erp:marketing:content:read')
  revisions(@Param('id') id: string) {
    return this.cms.revisionsFor(this.id(id));
  }

  @Patch('contents/:id')
  @RequiredScopes('erp:marketing:content:update')
  async update(
    @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined, @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.cms.update(this.id(id), this.version(ifMatch), this.key(key), body);
    response.setHeader('ETag', `"${String(result.content.version)}"`);
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
  ) {
    return this.runTransition(id, ifMatch, key, 'submit', 'in_review');
  }

  @Post('contents/:id/approve')
  @HttpCode(200)
  @RequiredScopes('erp:marketing:content:approve')
  approve(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return this.runTransition(id, ifMatch, key, 'approve', 'approved');
  }

  @Post('contents/:id/publish')
  @HttpCode(200)
  @RequiredScopes('erp:marketing:content:publish')
  publish(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return this.runTransition(id, ifMatch, key, 'publish', 'published');
  }

  @Post('contents/:id/schedule')
  @HttpCode(200)
  @RequiredScopes('erp:marketing:content:publish')
  async schedule(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    const scheduledAt = readString(body, 'scheduledAt');
    const result = await this.cms.schedule(
      this.id(id), this.version(ifMatch), this.key(key), scheduledAt,
    );
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
  ) {
    return this.runTransition(id, ifMatch, key, 'withdraw', 'archived');
  }

  @Post('contents/:id/restore')
  @HttpCode(200)
  @RequiredScopes('erp:marketing:content:update')
  restore(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return this.runTransition(id, ifMatch, key, 'restore', 'draft');
  }

  @Post('contents/:id/rollback')
  @HttpCode(200)
  @RequiredScopes('erp:marketing:content:rollback')
  async rollback(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    const revision = readPositiveInteger(body, 'revision');
    const result = await this.cms.rollback(
      this.id(id), revision, this.version(ifMatch), this.key(key),
    );
    await this.auditContent('marketing.content.rollback', result.content);
    return result;
  }

  @Get('leads')
  @RequiredScopes('erp:marketing:lead:read')
  leads() {
    return this.cms.listLeads();
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
    @Body() body: unknown,
  ) {
    const status = readString(body, 'status');
    const result = await this.cms.updateLeadStatus(this.id(id), status, this.version(ifMatch));
    await this.audit.record({
      action: 'marketing.lead.status.update', resourceType: 'marketing_lead',
      resourceId: id, riskLevel: 'R1', outcome: 'success',
      metadata: { status, version: Number(result.version) },
    });
    return result;
  }

  @Patch('leads/:id/assignee')
  @RequiredScopes('erp:marketing:lead:update')
  assignLead(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
  ) {
    return this.cms.assignLead(
      this.id(id), readString(body, 'assigneeId'), this.version(ifMatch),
    );
  }

  @Post('leads/:id/notes')
  @RequiredScopes('erp:marketing:lead:update')
  addLeadNote(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
  ) {
    return this.cms.addLeadNote(
      this.id(id), readString(body, 'body'), this.version(ifMatch),
    );
  }

  @Post('side-effects/:id/replay')
  @HttpCode(200)
  @RequiredScopes('erp:marketing:operations:replay')
  async replaySideEffect(@Param('id') id: string) {
    const result = await this.cms.replaySideEffect(this.id(id));
    try {
      await this.audit.record({
        action: 'marketing.side_effect.replay',
        resourceType: 'marketing_side_effect',
        resourceId: id,
        riskLevel: 'R2',
        outcome: 'success',
        metadata: { kind: String(result.kind), status: String(result.status) },
      });
    } catch {
      this.logger.error({
        code: 'MARKETING_SIDE_EFFECT_REPLAY_AUDIT_FAILED',
        resourceId: id,
      });
    }
    return result;
  }

  @Post('media/uploads')
  @RequiredScopes('erp:marketing:media:create')
  createMedia(@Body() body: unknown) {
    return this.cms.createMediaUpload(body);
  }

  @Post('media/:id/verify')
  @HttpCode(200)
  @RequiredScopes('erp:marketing:media:create')
  verifyMedia(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
  ) {
    return this.cms.verifyMedia(this.id(id), this.version(ifMatch));
  }

  @Get('media')
  @RequiredScopes('erp:marketing:media:read')
  media() {
    return this.cms.listMedia();
  }

  @Post('contents/:id/ai-drafts')
  @RequiredScopes('erp:marketing:ai:generate')
  async aiDraft(@Param('id') id: string, @Body() body: unknown) {
    const result = await this.cms.generateAiDraft(this.id(id), body);
    await this.audit.record({
      action: 'marketing.ai.draft.generate', resourceType: 'marketing_content',
      resourceId: id, riskLevel: 'R1', outcome: 'success',
      metadata: { generationId: String(result.id), status: String(result.status) },
    });
    return result;
  }

  @Post('ai-drafts/:id/review')
  @HttpCode(200)
  @RequiredScopes('erp:marketing:ai:review')
  async reviewAiDraft(@Param('id') id: string, @Body() body: unknown) {
    const decision = readString(body, 'decision');
    if (decision !== 'accepted' && decision !== 'rejected') throw invalidBody();
    const result = await this.cms.reviewAiDraft(this.id(id), decision);
    await this.audit.record({
      action: 'marketing.ai.draft.review', resourceType: 'marketing_ai_generation',
      resourceId: id, riskLevel: 'R1', outcome: 'success',
      metadata: { decision, contentId: String(result.contentId) },
    });
    return result;
  }

  private async auditContent(action: string, content: Readonly<Record<string, unknown>>) {
    try {
      await this.audit.record({
        action, resourceType: 'marketing_content', resourceId: String(content.id),
        riskLevel: action.endsWith('publish') ? 'R2' : 'R1', outcome: 'success',
        metadata: { status: String(content.status), revision: Number(content.revision) },
      });
    } catch {
      this.logger.error({
        code: 'MARKETING_AUDIT_WRITE_FAILED',
        action,
        resourceId: String(content.id),
      });
    }
  }

  private async runTransition(
    id: string,
    ifMatch: string | undefined,
    key: string | undefined,
    action: string,
    target: 'draft' | 'in_review' | 'approved' | 'published' | 'archived',
  ) {
    const result = await this.cms.transition(
      this.id(id), this.version(ifMatch), this.key(key), target,
    );
    await this.auditContent(`marketing.content.${action}`, result.content);
    return result;
  }

  private id(value: string): string {
    if (!ID.test(value)) throw new BadRequestException({ code: 'CMS_ID_INVALID', message: '内容标识无效' });
    return value;
  }
  private key(value: string | undefined): string {
    if (value === undefined || value.length < 8) throw new BadRequestException({
      code: 'IDEMPOTENCY_KEY_REQUIRED', message: '写接口必须提供 Idempotency-Key',
    });
    return value;
  }
  private version(value: string | undefined): number {
    const match = IF_MATCH.exec(value ?? '');
    if (match?.[1] === undefined) throw new BadRequestException({
      code: 'CMS_IF_MATCH_REQUIRED', message: '写接口必须提供强 If-Match',
    });
    return Number(match[1]);
  }
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
  constructor(
    private readonly cms: MarketingCmsService,
    private readonly protection: MarketingPublicProtectionService,
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
  async submitLead(@Body() body: unknown, @Req() request: Request) {
    const { captchaToken, lead } = publicLeadRequest(body);
    await this.protection.assertAllowed(request.ip ?? request.socket.remoteAddress ?? 'unknown', captchaToken);
    return this.cms.submitLead(lead);
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
