import { HttpException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createHash } from 'node:crypto';
import type { Response } from 'express';
import { z } from 'zod';

import type { AppEnvironment } from '../config/environment.js';
import { IdentityContextService } from '../identity/identity-context.service.js';
import type { AuthenticatedPayrollRequest } from '../identity/identity.types.js';
import { PayrollApplicationService } from '../payroll/payroll-application.service.js';

const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u);
const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const moneySchema = z.string().regex(/^-?(?:0|[1-9]\d*)$/u);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

const payslipOutputSchema = z.object({
  payslip: z.object({
    payrollRunId: idSchema,
    period: periodSchema,
    status: z.enum(['locked', 'reconciling', 'reconciled']),
    ruleVersion: z.number().int().min(1),
    grossMinor: moneySchema,
    taxableIncomeMinor: moneySchema,
    totalDeductionMinor: moneySchema,
    withholdingTaxMinor: moneySchema,
    netMinor: moneySchema,
    resultDigest: digestSchema,
  }).strict(),
}).strict();
const periodOutputSchema = z.object({
  period: z.object({
    payrollRunId: idSchema,
    period: periodSchema,
    status: z.string().min(1).max(64),
    employeeCount: z.number().int().min(0),
    resultDigest: digestSchema.nullable(),
    version: z.number().int().min(1),
  }).strict(),
}).strict();
const reconciliationOutputSchema = z.object({
  reconciliation: z.object({
    payrollRunId: idSchema,
    period: periodSchema,
    status: z.enum(['not_started', 'in_progress', 'reconciled']),
    evidenceDigest: digestSchema.nullable(),
    version: z.number().int().min(1),
  }).strict(),
}).strict();
const taxOutputSchema = z.object({
  taxFiling: z.object({
    payrollRunId: idSchema,
    period: periodSchema,
    status: z.literal('not_started'),
    evidenceDigest: z.null(),
    version: z.number().int().min(1),
  }).strict(),
}).strict();

const capabilityCatalog = Object.freeze({
  protocolVersion: '2025-11-25',
  tools: Object.freeze([
    'payroll_payslip_get_self',
    'payroll_period_get',
    'payroll_reconciliation_get',
    'payroll_tax_filing_get',
  ]),
  resourceTemplates: Object.freeze([
    'payroll://payslips/self/{period}',
    'payroll://periods/{period}',
  ]),
  prompts: Object.freeze([
    'payroll_payslip_explain_self',
    'payroll_period_status_guide',
  ]),
  r3ToolCount: 0,
});
const catalogHash = createHash('sha256')
  .update(JSON.stringify(capabilityCatalog))
  .digest('hex');

@Injectable()
export class McpRuntimeService {
  private readonly allowedOrigins: ReadonlySet<string>;

  constructor(
    config: ConfigService<AppEnvironment, true>,
    private readonly identity: IdentityContextService,
    private readonly payroll: PayrollApplicationService,
  ) {
    this.allowedOrigins = new Set(
      config.get('MCP_ALLOWED_ORIGINS', { infer: true })
        .split(',').map((value) => value.trim()).filter(Boolean),
    );
  }

  isOriginAllowed(origin: string | undefined): boolean {
    return origin === undefined || this.allowedOrigins.has(origin);
  }

  async handle(request: AuthenticatedPayrollRequest, response: Response): Promise<void> {
    const identity = this.identity.requireScope('erp:payroll:mcp:connect');
    const authorization = request.headers.authorization;
    if (authorization === undefined || !authorization.startsWith('Bearer ')) {
      throw new Error('MCP_AUTH_CONTEXT_MISSING');
    }
    const authInfo: AuthInfo = {
      token: authorization.slice(7),
      clientId: identity.clientId,
      scopes: [...identity.scopes],
      expiresAt: identity.expiresAt,
      resource: new URL(identity.resource[0] ?? ''),
    };
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    const server = await this.connect(transport);
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') headers.set(name, value);
      else if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    }
    const base = new URL(identity.resource[0] ?? '');
    const webRequest = new Request(new URL(request.originalUrl, base.origin), {
      method: request.method,
      headers,
    });
    try {
      const webResponse = await transport.handleRequest(webRequest, {
        authInfo,
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

  /** 连接官方 Transport，供 Streamable HTTP 与协议级测试复用同一目录。 */
  async connect(transport: Transport): Promise<McpServer> {
    const server = this.createServer();
    await server.connect(transport);
    return server;
  }

  private createServer(): McpServer {
    const server = new McpServer({
      name: 'gaoq-payroll',
      version: '0.1.0',
      description: 'GaoQ 专业算薪独立 OAuth Resource MCP 服务',
    });
    this.registerCapabilities(server);
    return server;
  }

  private registerCapabilities(server: McpServer): void {
    server.registerResource(
      'payroll-mcp-catalog',
      'payroll://mcp/catalog',
      { title: '专业算薪 MCP 能力目录', mimeType: 'application/json' },
      (uri) => ({ contents: [{
        uri: uri.toString(), mimeType: 'application/json',
        text: JSON.stringify({ ...capabilityCatalog, catalogHash }),
      }] }),
    );
    server.registerResource(
      'payroll-payslip-self',
      new ResourceTemplate('payroll://payslips/self/{period}', { list: undefined }),
      { title: '本人已发布工资条', mimeType: 'application/json' },
      async (uri, { period }) => {
        const value = await this.selfPayslip(requiredString(period));
        return { contents: [{ uri: uri.toString(), mimeType: 'application/json', text: JSON.stringify(value) }] };
      },
    );
    server.registerResource(
      'payroll-period',
      new ResourceTemplate('payroll://periods/{period}', { list: undefined }),
      { title: '工资期间控制摘要', mimeType: 'application/json' },
      async (uri, { period }) => {
        const value = { period: await this.payroll.getPeriod(requiredString(period)) };
        return { contents: [{ uri: uri.toString(), mimeType: 'application/json', text: JSON.stringify(value) }] };
      },
    );
    server.registerPrompt(
      'payroll_payslip_explain_self',
      {
        title: '解释本人工资条',
        description: '仅解释当前员工本人的已发布工资条，不比较或推断他人薪酬。',
        argsSchema: { period: periodSchema },
      },
      ({ period }) => ({ messages: [{ role: 'user', content: {
        type: 'text',
        text: `请读取 ${period} 的本人工资条，只解释税前、扣除、预扣税和实发金额；不得推断或比较他人薪酬，不得触发重算、审批、导出或发放。`,
      } }] }),
    );
    server.registerPrompt(
      'payroll_period_status_guide',
      {
        title: '工资期间状态解读',
        description: '解释工资期间、对账和税务控制状态，不执行任何写操作。',
        argsSchema: { period: periodSchema },
      },
      ({ period }) => ({ messages: [{ role: 'user', content: {
        type: 'text',
        text: `请读取 ${period} 的工资期间控制摘要，说明当前状态、是否已锁定、对账和税务是否开始；不得创建、计算、审批、锁定或提交。`,
      } }] }),
    );

    server.registerTool(
      'payroll_payslip_get_self',
      readOnlyTool('查询本人已发布工资条', { period: periodSchema }, payslipOutputSchema, 'R1'),
      async ({ period }: { period: string }) => this.result(() => this.selfPayslip(period)),
    );
    server.registerTool(
      'payroll_period_get',
      readOnlyTool('查询工资期间控制摘要', { period: periodSchema }, periodOutputSchema, 'R1'),
      async ({ period }: { period: string }) =>
        this.result(async () => ({ period: await this.payroll.getPeriod(period) })),
    );
    server.registerTool(
      'payroll_reconciliation_get',
      readOnlyTool('查询工资对账控制状态', { payrollRunId: idSchema }, reconciliationOutputSchema, 'R1'),
      async ({ payrollRunId }: { payrollRunId: string }) => this.result(async () => ({
        reconciliation: await this.payroll.getReconciliation(payrollRunId),
      })),
    );
    server.registerTool(
      'payroll_tax_filing_get',
      readOnlyTool('查询工资税务申报控制状态', { payrollRunId: idSchema }, taxOutputSchema, 'R1'),
      async ({ payrollRunId }: { payrollRunId: string }) => this.result(async () => ({
        taxFiling: await this.payroll.getTaxFiling(payrollRunId),
      })),
    );
  }

  private async selfPayslip(period: string) {
    const payslip = await this.payroll.getSelfPayslip(period);
    return { payslip: {
      payrollRunId: payslip.payrollRunId,
      period: payslip.period,
      status: payslip.status,
      ruleVersion: payslip.ruleVersion,
      grossMinor: payslip.grossMinor,
      taxableIncomeMinor: payslip.taxableIncomeMinor,
      totalDeductionMinor: payslip.totalDeductionMinor,
      withholdingTaxMinor: payslip.withholdingTaxMinor,
      netMinor: payslip.netMinor,
      resultDigest: payslip.resultDigest,
    } };
  }

  private async result<T extends Record<string, unknown>>(operation: () => Promise<T>) {
    try {
      const value = await operation();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(value) }],
        structuredContent: value,
      };
    } catch (error) {
      const response = error instanceof HttpException ? error.getResponse() : null;
      const body = typeof response === 'object' && response !== null ? response : {};
      const code = 'code' in body && typeof body.code === 'string' ? body.code : 'PAYROLL_MCP_FAILED';
      const message = 'message' in body && typeof body.message === 'string'
        ? body.message : '专业算薪查询失败';
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify({ code, message }) }],
      };
    }
  }
}

function readOnlyTool<TInput extends z.ZodRawShape, TOutput extends z.ZodRawShape>(
  title: string,
  inputSchema: TInput,
  outputSchema: z.ZodObject<TOutput>,
  riskLevel: 'R1',
) {
  return {
    title,
    description: `${title}；复用专业算薪应用服务，不接受租户参数。风险等级 ${riskLevel}。`,
    inputSchema,
    outputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: {
      'com.gaoq/riskLevel': riskLevel,
      'com.gaoq/jsonSchemaDialect': 'https://json-schema.org/draft/2020-12/schema',
      'com.gaoq/confirmationMode': 'direct',
    },
  };
}

function requiredString(value: string | string[] | undefined): string {
  if (typeof value !== 'string') throw new Error('PAYROLL_MCP_TEMPLATE_ARGUMENT_INVALID');
  return value;
}
