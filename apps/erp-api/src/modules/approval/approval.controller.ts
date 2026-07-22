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
  ApprovalApplicationService,
  type ApprovalInstanceSummary,
  type ApprovalInstanceView,
  type ApprovalTimelineEntry,
  type ApprovalTemplateSummary,
  type ApprovalPublishedTemplateFormView,
} from './application/approval-application.service.js';
import {
  AddApprovalSignerDto,
  CreateApprovalInstanceDto,
  CreateApprovalTemplateDto,
  DecideApprovalInstanceDto,
  TransferApprovalTaskDto,
} from './application/approval.dto.js';

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const IF_MATCH_PATTERN = /^"([1-9][0-9]*)"$/;

/** 审批 REST 工作台；租户与主体完全来自已验证身份上下文。 */
@Controller('approvals')
export class ApprovalController {
  constructor(
    private readonly approvals: ApprovalApplicationService,
    private readonly audit: AuditService,
  ) {}

  @Get('templates/published')
  @RequiredScopes('erp:approval:instance:submit')
  async listPublishedTemplates(): Promise<readonly ApprovalPublishedTemplateFormView[]> {
    const templates = await this.approvals.listPublishedTemplateForms();
    await this.audit.record({
      action: 'approval.template.catalog.read',
      resourceType: 'approval_template_catalog',
      resourceId: 'published',
      riskLevel: 'R0',
      outcome: 'success',
      metadata: { count: templates.length },
    });
    return templates;
  }

  @Post('templates')
  @RequiredScopes('erp:approval:template:write')
  async createTemplate(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: CreateApprovalTemplateDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly template: ApprovalTemplateSummary }> {
    const result = await this.approvals.createTemplate(this.requireKey(key), body);
    this.setVersion(response, result.template.version);
    await this.auditSuccess('approval.template.create', 'approval_template', result.template);
    return result;
  }

  @Post('templates/:id/publish')
  @HttpCode(200)
  @RequiredScopes('erp:approval:template:publish')
  async publishTemplate(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly template: ApprovalTemplateSummary }> {
    const result = await this.publish(id, ifMatch, key);
    this.setVersion(response, result.template.version);
    await this.auditSuccess('approval.template.publish', 'approval_template', result.template);
    return result;
  }

  @Post('instances')
  @RequiredScopes('erp:approval:instance:submit')
  async createInstance(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: CreateApprovalInstanceDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly instance: ApprovalInstanceSummary }> {
    const result = await this.approvals.createInstance(this.requireKey(key), body);
    this.setVersion(response, result.instance.version);
    await this.auditInstance('approval.instance.create', result.instance);
    return result;
  }

  @Get('instances/inbox')
  @RequiredScopes('erp:approval:instance:read')
  async getInbox(): Promise<readonly ApprovalInstanceSummary[]> {
    return this.approvals.getInbox();
  }

  @Get('instances/:id')
  @RequiredScopes('erp:approval:instance:read')
  async getInstance(
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ApprovalInstanceView> {
    const result = await this.approvals.getInstance(this.requireUlid(id));
    this.setVersion(response, result.version);
    return result;
  }

  @Get('instances/:id/timeline')
  @RequiredScopes('erp:approval:instance:read')
  async getTimeline(@Param('id') id: string): Promise<readonly ApprovalTimelineEntry[]> {
    const instanceId = this.requireUlid(id);
    const timeline = await this.approvals.getTimeline(instanceId);
    await this.audit.record({
      action: 'approval.instance.timeline.read',
      resourceType: 'approval_instance',
      resourceId: instanceId,
      riskLevel: 'R0',
      outcome: 'success',
      metadata: { count: timeline.length },
    });
    return timeline;
  }

  @Post('instances/:id/submit')
  @HttpCode(200)
  @RequiredScopes('erp:approval:instance:submit')
  async submitInstance(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly instance: ApprovalInstanceSummary }> {
    return this.instanceWrite(
      'approval.instance.submit', response,
      this.approvals.submitInstance(this.requireUlid(id), this.requireVersion(ifMatch), this.requireKey(key)),
    );
  }

  @Post('instances/:id/decisions')
  @HttpCode(200)
  @RequiredScopes('erp:approval:task:decide')
  async decideInstance(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: DecideApprovalInstanceDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly instance: ApprovalInstanceSummary }> {
    return this.instanceWrite(
      'approval.instance.decide', response,
      this.approvals.decideInteractiveInstance(
        this.requireUlid(id), this.requireVersion(ifMatch), body.principalApproverId,
        body.outcome, this.requireKey(key),
      ),
    );
  }

  @Post('instances/:id/transfers')
  @HttpCode(200)
  @RequiredScopes('erp:approval:task:transfer')
  async transferTask(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: TransferApprovalTaskDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly instance: ApprovalInstanceSummary }> {
    return this.instanceWrite(
      'approval.instance.transfer', response,
      this.approvals.transferTask(
        this.requireUlid(id), this.requireVersion(ifMatch), body.fromApproverId,
        body.toApproverId, this.requireKey(key),
      ),
    );
  }

  @Post('instances/:id/add-signers')
  @HttpCode(200)
  @RequiredScopes('erp:approval:task:add_signer')
  async addSigner(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: AddApprovalSignerDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly instance: ApprovalInstanceSummary }> {
    return this.instanceWrite(
      'approval.instance.add_signer', response,
      this.approvals.addSigner(
        this.requireUlid(id), this.requireVersion(ifMatch), body.approverId, this.requireKey(key),
      ),
    );
  }

  @Post('instances/:id/withdraw')
  @HttpCode(200)
  @RequiredScopes('erp:approval:instance:submit')
  async withdrawInstance(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly instance: ApprovalInstanceSummary }> {
    return this.instanceWrite(
      'approval.instance.withdraw', response,
      this.approvals.withdrawInstance(
        this.requireUlid(id), this.requireVersion(ifMatch), this.requireKey(key),
      ),
    );
  }

  @Post('instances/:id/archive')
  @HttpCode(200)
  @RequiredScopes('erp:approval:instance:archive')
  async archiveInstance(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly instance: ApprovalInstanceSummary }> {
    return this.instanceWrite(
      'approval.instance.archive', response,
      this.approvals.archiveInstance(
        this.requireUlid(id), this.requireVersion(ifMatch), this.requireKey(key),
      ),
    );
  }

  private async publish(
    id: string,
    ifMatch: string | undefined,
    key: string | undefined,
  ): Promise<{ readonly template: ApprovalTemplateSummary }> {
    return this.approvals.publishTemplate(
      this.requireUlid(id), this.requireVersion(ifMatch), this.requireKey(key),
    );
  }

  private async instanceWrite(
    action: string,
    response: Response,
    operation: Promise<{ readonly instance: ApprovalInstanceSummary }>,
  ): Promise<{ readonly instance: ApprovalInstanceSummary }> {
    const result = await operation;
    this.setVersion(response, result.instance.version);
    await this.auditInstance(action, result.instance);
    return result;
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
      code: 'APPROVAL_IF_MATCH_REQUIRED', message: '写接口必须提供强 If-Match 版本，例如 "3"',
    });
    return version;
  }

  private requireUlid(value: string): string {
    if (!ULID_PATTERN.test(value)) throw new BadRequestException({
      code: 'APPROVAL_INVALID_ID', message: '审批资源标识必须为严格 ULID',
    });
    return value;
  }

  private setVersion(response: Response, version: number): void {
    response.setHeader('ETag', `"${version}"`);
  }

  private async auditInstance(action: string, instance: ApprovalInstanceSummary): Promise<void> {
    await this.auditSuccess(action, 'approval_instance', instance);
  }

  private async auditSuccess(
    action: string,
    resourceType: string,
    resource: { readonly id: string; readonly riskLevel: 'R1' | 'R2'; readonly version: number },
  ): Promise<void> {
    await this.audit.record({
      action,
      resourceType,
      resourceId: resource.id,
      riskLevel: resource.riskLevel,
      outcome: 'success',
      metadata: { version: resource.version },
    });
  }
}
