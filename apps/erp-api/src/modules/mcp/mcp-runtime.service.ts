import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Response } from 'express';
import { z } from 'zod';

import type { AppEnvironment } from '../../config/environment.js';
import type { ErpRequest } from '../../core/http/request-context.js';
import { McpToolService } from './mcp-tool.service.js';

const permissionsOutputSchema = z.object({
  actorId: z.string(),
  roleCodes: z.array(z.string()),
  scopes: z.array(z.string()),
  departmentIds: z.array(z.string()),
});

const orgChartOutputSchema = z.object({
  departments: z.array(z.object({
    id: z.string(),
    tenantId: z.string(),
    code: z.string(),
    name: z.string(),
    status: z.enum(['active', 'inactive']),
    parentId: z.string().nullable(),
    managerId: z.string().nullable(),
    sortOrder: z.number().int().nonnegative(),
    version: z.number().int().positive(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })),
  employees: z.array(z.object({
    id: z.string(),
    tenantId: z.string(),
    employeeNo: z.string(),
    displayName: z.string(),
    status: z.enum(['probation', 'active', 'suspended', 'terminated']),
    departmentIds: z.array(z.string()),
    primaryDepartmentId: z.string(),
    positionIds: z.array(z.string()),
    jobLevelId: z.string().nullable(),
    version: z.number().int().positive(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })),
});

const approvalSummarySchema = z.object({
  id: z.string(),
  status: z.enum(['draft', 'running', 'approved', 'rejected', 'withdrawn', 'archived']),
  templateCode: z.string(),
  templateRevision: z.number().int().positive(),
  riskLevel: z.enum(['R1', 'R2']),
  version: z.number().int().positive(),
  submittedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});

const approvalInboxOutputSchema = z.object({ items: z.array(approvalSummarySchema) });
const readableFormValueSchema = z.union([
  z.string(), z.number(), z.boolean(), z.null(),
  z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
  z.object({ redacted: z.literal(true) }),
]);
const approvalInstanceOutputSchema = z.object({
  instance: z.object({
    id: z.string(),
    title: z.string(),
    initiatorId: z.string(),
    status: z.enum(['draft', 'running', 'approved', 'rejected', 'withdrawn', 'archived']),
    templateCode: z.string(),
    templateRevision: z.number().int().positive(),
    riskLevel: z.enum(['R1', 'R2']),
    formData: z.record(z.string(), readableFormValueSchema),
    currentNodeIndex: z.number().int().nonnegative().nullable(),
    version: z.number().int().positive(),
    submittedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
  }),
});
const preparedOperationOutputSchema = z.object({
  operationId: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
  digest: z.string().length(43),
  riskLevel: z.enum(['R1', 'R2']),
  expiresAt: z.string(),
  confirmationUrl: z.string().url(),
});
const approvalWriteOutputSchema = z.object({ instance: approvalSummarySchema });
const approvalOperationInputSchema = {
  instanceId: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
  expectedVersion: z.number().int().positive(),
  prepareKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
};
const confirmationExecuteInputSchema = {
  operationId: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
  confirmationCredential: z.string().regex(/^mcpc_[A-Za-z0-9_-]{43}$/),
};
const recruitmentIdSchema = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const recruitmentApplicationSchema = z.object({
  id: recruitmentIdSchema, candidateId: recruitmentIdSchema, positionId: recruitmentIdSchema,
  stage: z.enum([
    'applied', 'screening', 'interview', 'offer_approval', 'offer_sent',
    'offer_accepted', 'preboarding', 'hired', 'rejected', 'withdrawn',
  ]),
  version: z.number().int().positive(), appliedAt: z.string(), endedAt: z.string().nullable(),
});
const recruitmentRequisitionSchema = z.object({
  id: recruitmentIdSchema, departmentId: z.string(), positionTitle: z.string(),
  headcount: z.number().int().positive(),
  status: z.enum(['draft', 'pending_approval', 'approved', 'rejected', 'closed']),
  approvalInstanceId: recruitmentIdSchema.nullable(), version: z.number().int().positive(),
});
const recruitmentPositionSchema = z.object({
  id: recruitmentIdSchema, requisitionId: recruitmentIdSchema, title: z.string(),
  departmentId: z.string(), jobLevelId: z.string(), location: z.string(),
  headcount: z.number().int().positive(), status: z.enum(['draft', 'open', 'paused', 'closed']),
  version: z.number().int().positive(), publishedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
});
const recruitmentInterviewSchema = z.object({
  id: recruitmentIdSchema, applicationId: recruitmentIdSchema,
  roundNumber: z.number().int().positive(), mode: z.enum(['onsite', 'video', 'phone']),
  startsAt: z.string(), endsAt: z.string(), timezone: z.string(),
  interviewerIds: z.array(z.string()),
  status: z.enum(['scheduled', 'completed', 'cancelled']),
  version: z.number().int().positive(), completedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
});
const recruitmentOfferSchema = z.object({
  id: recruitmentIdSchema, applicationId: recruitmentIdSchema, positionId: recruitmentIdSchema,
  completedInterviewId: recruitmentIdSchema,
  status: z.enum([
    'draft', 'pending_approval', 'approved', 'rejected', 'sending', 'sent',
    'accepted', 'declined', 'expired', 'cancelled', 'signed',
  ]),
  expiresAt: z.string(), approvalInstanceId: recruitmentIdSchema.nullable(),
  sendRequestId: z.string().nullable(), sentEvidenceId: z.string().nullable(),
  acceptanceEvidenceId: z.string().nullable(), esignFlowId: z.string().nullable(),
  signedEvidenceId: z.string().nullable(), version: z.number().int().positive(),
});
const recruitmentWriteOutputSchemas = {
  requisition: z.object({ requisition: recruitmentRequisitionSchema }),
  position: z.object({ position: recruitmentPositionSchema }),
  offer: z.object({ offer: recruitmentOfferSchema }),
};

@Injectable()
export class McpRuntimeService {
  private readonly logger = new Logger(McpRuntimeService.name);
  private readonly allowedOrigins: ReadonlySet<string>;

  constructor(
    @Inject(ConfigService) config: ConfigService<AppEnvironment, true>,
    @Inject(McpToolService) private readonly tools: McpToolService,
  ) {
    this.allowedOrigins = new Set(
      config
        .get('MCP_ALLOWED_ORIGINS', { infer: true })
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    );
  }

  /** 校验 Origin，阻止 Streamable HTTP DNS rebinding。 */
  isOriginAllowed(origin: string | undefined): boolean {
    return origin === undefined || this.allowedOrigins.has(origin);
  }

  /** 将已经过统一 JWT Guard 的请求交给官方 Streamable HTTP transport。 */
  async handle(request: ErpRequest, response: Response): Promise<void> {
    const token = request.verifiedAccessToken;
    if (token === undefined || request.bearerToken === undefined || request.traceId === undefined) {
      throw new Error('MCP 认证上下文未建立');
    }
    const auth: AuthInfo = {
      token: request.bearerToken,
      clientId: token.clientId,
      scopes: [...token.scopes],
      expiresAt: token.expiresAt,
      resource: new URL(token.resource[0] ?? ''),
      extra: {
        tenantId: token.tenantId,
        actorId: token.actorId,
        actorType: token.actorType,
        roleCodes: [...token.roleCodes],
        departmentIds: [...token.departmentIds],
        traceId: request.traceId,
      },
    };
    // SDK 1.29 明确要求无状态模式每个 HTTP 请求创建独立 transport；复用会被拒绝。
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    transport.onerror = (error) => this.logger.error(`MCP transport：${error.message}`);
    const server = this.createServer();
    await server.connect(transport);
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') headers.set(name, value);
      else if (Array.isArray(value)) {
        for (const item of value) headers.append(name, item);
      }
    }
    const baseUrl = token.resource[0] ?? '';
    const webRequest = new Request(new URL(request.originalUrl, baseUrl), {
      method: request.method,
      headers,
    });
    try {
      const webResponse = await transport.handleRequest(webRequest, {
        authInfo: auth,
        parsedBody: request.body,
      });
      response.status(webResponse.status);
      webResponse.headers.forEach((value, name) => response.setHeader(name, value));
      if (webResponse.body === null) {
        response.end();
        return;
      }
      const reader = webResponse.body.getReader();
      response.once('close', () => {
        if (!response.writableEnded) void reader.cancel('客户端连接已关闭');
      });
      while (!response.destroyed) {
        const chunk = await reader.read();
        if (chunk.done) break;
        response.write(Buffer.from(chunk.value));
      }
      if (!response.writableEnded) response.end();
    } finally {
      await server.close();
    }
  }

  private createServer(): McpServer {
    const server = new McpServer(
      {
        name: 'gaoq-erp',
        version: '0.1.0',
        description: 'GaoQ-OS 企业运营 MCP 服务',
      },
      {
        capabilities: {
          logging: {},
          extensions: { 'io.modelcontextprotocol/oauth-client-credentials': {} },
        },
      },
    );
    this.registerCapabilities(server);
    return server;
  }

  private registerCapabilities(server: McpServer): void {
    server.registerResource(
      'mcp-usage-guide',
      'gaoq://mcp/guide',
      {
        title: 'GaoQ-OS MCP 使用指南',
        description: '风险分级、授权边界和可用能力说明',
        mimeType: 'text/markdown',
      },
      () => ({
        contents: [
          {
            uri: 'gaoq://mcp/guide',
            mimeType: 'text/markdown',
            text: '# GaoQ-OS MCP\n\n所有调用受 OAuth Scope、租户、角色、数据范围和审计约束。R3 操作禁止 AI 直接执行。',
          },
        ],
      }),
    );

    server.registerResource(
      'approval-pending',
      'erp://approval/pending',
      {
        title: '我的待办审批',
        description: '按当前已验证主体返回待办摘要；不返回表单正文。',
        mimeType: 'application/json',
      },
      async (uri, extra) => {
        const result = await this.tools.getApprovalInbox(extra);
        if (result.isError === true) throw new Error('无权读取审批待办');
        return {
          contents: [{
            uri: uri.toString(),
            mimeType: 'application/json',
            text: JSON.stringify(result.structuredContent ?? { items: [] }),
          }],
        };
      },
    );

    server.registerResource(
      'recruitment-application',
      new ResourceTemplate('erp://recruitment/applications/{id}', { list: undefined }),
      {
        title: '候选申请摘要',
        description: '按已验证主体和部门数据范围读取申请阶段；不返回候选人身份或评价原文。',
        mimeType: 'application/json',
      },
      async (uri, { id }, extra) => {
        const result = await this.tools.getRecruitmentApplication(requiredResourceId(id), extra);
        if (result.isError === true) throw new Error('无权读取候选申请');
        return { contents: [{
          uri: uri.toString(), mimeType: 'application/json',
          text: JSON.stringify(result.structuredContent ?? {}),
        }] };
      },
    );

    server.registerResource(
      'recruitment-offer',
      new ResourceTemplate('erp://recruitment/offers/{id}', { list: undefined }),
      {
        title: 'Offer 脱敏摘要',
        description: '读取 Offer 状态和证据引用；永不返回 L4 薪酬、福利或签署文件。',
        mimeType: 'application/json',
      },
      async (uri, { id }, extra) => {
        const result = await this.tools.getRecruitmentOffer(requiredResourceId(id), extra);
        if (result.isError === true) throw new Error('无权读取 Offer');
        return { contents: [{
          uri: uri.toString(), mimeType: 'application/json',
          text: JSON.stringify(result.structuredContent ?? {}),
        }] };
      },
    );

    server.registerPrompt(
      'approval_submission_guide',
      {
        title: '审批提交检查清单',
        description: '指导用户检查审批内容并明确进入服务端确认流程，不代替用户确认。',
        argsSchema: { templateCode: z.string().min(1).max(64) },
      },
      ({ templateCode }) => ({
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `请按模板 ${templateCode} 检查必填字段、附件引用、审批路径和敏感信息。不要直接执行提交；先调用 approval_submit_prepare，并引导用户在 ERP 确认页核对影响。`,
          },
        }],
      }),
    );

    server.registerPrompt(
      'recruitment_offer_send_guide',
      {
        title: 'Offer 发送前检查清单',
        description: '只检查状态、版本、审批与证据引用，不要求 AI 展示或复述 L4 条款。',
        argsSchema: { offerId: recruitmentIdSchema },
      },
      ({ offerId }) => ({
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `请查询 Offer ${offerId} 的脱敏摘要，确认状态为 approved、版本未变化且审批引用存在。不要索取或复述薪酬、福利和签署文件；发送前调用 recruitment_offer_send_prepare 并引导用户在 ERP 完成 R2 强认证确认。`,
          },
        }],
      }),
    );

    server.registerTool(
      'get_my_permissions',
      {
        title: '查询我的权限',
        description: '返回当前已验证主体的角色、Scope 与部门数据范围，不接受租户参数。',
        outputSchema: permissionsOutputSchema,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      async (extra) => this.tools.getMyPermissions(extra),
    );

    server.registerTool(
      'approval_get_inbox',
      {
        title: '查询我的审批待办',
        description: '返回当前主体可处理的审批摘要，不接受租户参数且不返回表单正文。风险等级 R0。',
        outputSchema: approvalInboxOutputSchema,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      async (extra) => this.tools.getApprovalInbox(extra),
    );

    server.registerTool(
      'approval_get',
      {
        title: '查询审批详情',
        description: '按当前主体权限返回审批详情；L3/L4 字段由应用服务脱敏。风险等级 R0。',
        inputSchema: { instanceId: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/) },
        outputSchema: approvalInstanceOutputSchema,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      async ({ instanceId }, extra) => this.tools.getApprovalInstance(instanceId, extra),
    );

    server.registerTool(
      'approval_submit_prepare',
      {
        title: '准备提交审批',
        description: '校验草稿和版本并生成 R1 服务端确认单；不会提交审批。',
        inputSchema: approvalOperationInputSchema,
        outputSchema: preparedOperationOutputSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ instanceId, expectedVersion, prepareKey }, extra) =>
        this.tools.prepareApprovalSubmit(instanceId, expectedVersion, prepareKey, extra),
    );

    server.registerTool(
      'approval_submit_execute',
      {
        title: '执行提交审批',
        description: '仅在 ERP 用户确认后，使用一次性确认凭据幂等提交审批。风险等级 R1。',
        inputSchema: confirmationExecuteInputSchema,
        outputSchema: approvalWriteOutputSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ operationId, confirmationCredential }, extra) =>
        this.tools.executeApprovalSubmit(operationId, confirmationCredential, extra),
    );

    server.registerTool(
      'approval_withdraw_prepare',
      {
        title: '准备撤回审批',
        description: '校验当前审批状态并生成 R1 服务端确认单；不会撤回审批。',
        inputSchema: approvalOperationInputSchema,
        outputSchema: preparedOperationOutputSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ instanceId, expectedVersion, prepareKey }, extra) =>
        this.tools.prepareApprovalWithdraw(instanceId, expectedVersion, prepareKey, extra),
    );

    server.registerTool(
      'approval_withdraw_execute',
      {
        title: '执行撤回审批',
        description: '仅在 ERP 用户确认后，使用一次性确认凭据幂等撤回审批。风险等级 R1。',
        inputSchema: confirmationExecuteInputSchema,
        outputSchema: approvalWriteOutputSchema,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      async ({ operationId, confirmationCredential }, extra) =>
        this.tools.executeApprovalWithdraw(operationId, confirmationCredential, extra),
    );

    server.registerTool(
      'approval_decide_prepare',
      {
        title: '准备处理审批',
        description: '校验审批任务并生成 R2 服务端确认单；不会形成通过或拒绝决策。',
        inputSchema: {
          ...approvalOperationInputSchema,
          principalApproverId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
          outcome: z.enum(['approved', 'rejected']),
        },
        outputSchema: preparedOperationOutputSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (input, extra) => this.tools.prepareApprovalDecision(input, extra),
    );

    server.registerTool(
      'approval_decide_execute',
      {
        title: '执行审批决策',
        description: '仅在 ERP 强认证与独立审批约束满足后执行决策。风险等级 R2；强认证未配置时失败关闭。',
        inputSchema: confirmationExecuteInputSchema,
        outputSchema: approvalWriteOutputSchema,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      async ({ operationId, confirmationCredential }, extra) =>
        this.tools.executeApprovalDecision(operationId, confirmationCredential, extra),
    );

    server.registerTool(
      'get_org_chart',
      {
        title: '查询组织架构',
        description: '按当前主体的数据权限返回部门与员工组织视图，不接受租户或越权部门参数。',
        outputSchema: orgChartOutputSchema,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      async (extra) => this.tools.getOrgChart(extra),
    );

    server.registerTool(
      'recruitment_application_get',
      {
        title: '查询候选申请摘要',
        description: '按当前主体部门数据范围返回阶段摘要，不返回候选人身份、简历或评价。风险等级 R0。',
        inputSchema: { id: recruitmentIdSchema },
        outputSchema: z.object({ application: recruitmentApplicationSchema }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      async ({ id }, extra) => this.tools.getRecruitmentApplication(id, extra),
    );

    server.registerTool(
      'recruitment_requisition_get',
      {
        title: '查询 HC 摘要',
        description: '返回 HC 状态、人数和审批引用，不返回申请理由原文。风险等级 R0。',
        inputSchema: { id: recruitmentIdSchema },
        outputSchema: z.object({ requisition: recruitmentRequisitionSchema }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      async ({ id }, extra) => this.tools.getRecruitmentRequisition(id, extra),
    );

    server.registerTool(
      'recruitment_position_get',
      {
        title: '查询招聘职位摘要',
        description: '返回职位及 HC 引用并沿用部门数据范围。风险等级 R0。',
        inputSchema: { id: recruitmentIdSchema },
        outputSchema: z.object({ position: recruitmentPositionSchema }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      async ({ id }, extra) => this.tools.getRecruitmentPosition(id, extra),
    );

    server.registerTool(
      'recruitment_interview_get',
      {
        title: '查询面试摘要',
        description: '返回时间、面试官与状态，不返回地点/会议链接或评价原文。风险等级 R0。',
        inputSchema: { id: recruitmentIdSchema },
        outputSchema: z.object({ interview: recruitmentInterviewSchema }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      async ({ id }, extra) => this.tools.getRecruitmentInterview(id, extra),
    );

    server.registerTool(
      'recruitment_offer_get',
      {
        title: '查询 Offer 脱敏摘要',
        description: '只返回状态和证据引用，不返回任何 L4 条款。风险等级 R0。',
        inputSchema: { id: recruitmentIdSchema },
        outputSchema: z.object({ offer: recruitmentOfferSchema }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      async ({ id }, extra) => this.tools.getRecruitmentOffer(id, extra),
    );

    server.registerTool(
      'recruitment_requisition_submit_prepare',
      {
        title: '准备提交 HC 审批',
        description: '校验 HC 草稿和版本并创建 R2 确认单；不会提交。',
        inputSchema: {
          requisitionId: recruitmentIdSchema,
          expectedVersion: z.number().int().positive(),
          prepareKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
        },
        outputSchema: preparedOperationOutputSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ requisitionId, expectedVersion, prepareKey }, extra) =>
        this.tools.prepareRecruitmentRequisitionSubmit(
          requisitionId, expectedVersion, prepareKey, extra,
        ),
    );

    server.registerTool(
      'recruitment_requisition_submit_execute',
      {
        title: '执行提交 HC 审批',
        description: '仅在 ERP R2 强认证确认后幂等提交 HC 审批。',
        inputSchema: confirmationExecuteInputSchema,
        outputSchema: recruitmentWriteOutputSchemas.requisition,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ operationId, confirmationCredential }, extra) =>
        this.tools.executeRecruitmentRequisitionSubmit(
          operationId, confirmationCredential, extra,
        ),
    );

    server.registerTool(
      'recruitment_position_transition_prepare',
      {
        title: '准备变更职位状态',
        description: '校验职位状态和版本并创建 R1 确认单；不会修改职位。',
        inputSchema: {
          positionId: recruitmentIdSchema,
          expectedVersion: z.number().int().positive(),
          targetStatus: z.enum(['open', 'paused', 'closed']),
          prepareKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
        },
        outputSchema: preparedOperationOutputSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (input, extra) => this.tools.prepareRecruitmentPositionTransition(input, extra),
    );

    server.registerTool(
      'recruitment_position_transition_execute',
      {
        title: '执行职位状态变更',
        description: '仅消费 ERP 用户确认后的固化命令；关闭职位为不可逆业务动作。风险等级 R1。',
        inputSchema: confirmationExecuteInputSchema,
        outputSchema: recruitmentWriteOutputSchemas.position,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      async ({ operationId, confirmationCredential }, extra) =>
        this.tools.executeRecruitmentPositionTransition(
          operationId, confirmationCredential, extra,
        ),
    );

    server.registerTool(
      'recruitment_offer_send_prepare',
      {
        title: '准备发送 Offer',
        description: '只校验脱敏状态和版本并创建 R2 确认单；不会读取条款或形成投递事实。',
        inputSchema: {
          offerId: recruitmentIdSchema,
          expectedVersion: z.number().int().positive(),
          prepareKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
        },
        outputSchema: preparedOperationOutputSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ offerId, expectedVersion, prepareKey }, extra) =>
        this.tools.prepareRecruitmentOfferSend(offerId, expectedVersion, prepareKey, extra),
    );

    server.registerTool(
      'recruitment_offer_send_execute',
      {
        title: '执行 Offer 发送请求',
        description: '仅在 ERP R2 强认证确认后创建 sending 意图；投递回执前仍不视为已发送。',
        inputSchema: confirmationExecuteInputSchema,
        outputSchema: recruitmentWriteOutputSchemas.offer,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ operationId, confirmationCredential }, extra) =>
        this.tools.executeRecruitmentOfferSend(operationId, confirmationCredential, extra),
    );
  }
}

function requiredResourceId(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value)) {
    throw new Error('MCP_RECRUITMENT_RESOURCE_ID_INVALID');
  }
  return value;
}
