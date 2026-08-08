import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../config/environment.js';
import type { IdentityContextService } from '../identity/identity-context.service.js';
import type { PayrollApplicationService } from '../payroll/payroll-application.service.js';
import { McpRuntimeService } from './mcp-runtime.service.js';

describe('专业算薪 MCP 官方 SDK 协议', () => {
  let client: Client | undefined;
  let closeServer: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (client !== undefined) await client.close();
    if (closeServer !== undefined) await closeServer();
  });

  it('发现固定四 Tool、两模板、两 Prompt 并调用期间查询', async () => {
    const payroll = {
      getPeriod: vi.fn().mockResolvedValue({
        payrollRunId: 'run-001',
        period: '2026-07',
        status: 'locked',
        employeeCount: 3,
        resultDigest: 'a'.repeat(64),
        version: 4,
      }),
    } as unknown as PayrollApplicationService;
    const config = {
      get: vi.fn().mockReturnValue('https://payroll.example.com'),
    } as unknown as ConfigService<AppEnvironment, true>;
    const identity = {} as IdentityContextService;
    const runtime = new McpRuntimeService(config, identity, payroll);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await runtime.connect(serverTransport);
    closeServer = () => server.close();
    client = new Client({ name: 'payroll-protocol-test', version: '1.0.0' });
    await client.connect(clientTransport);

    const [tools, resources, templates, prompts] = await Promise.all([
      client.listTools(),
      client.listResources(),
      client.listResourceTemplates(),
      client.listPrompts(),
    ]);
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'payroll_payslip_get_self',
      'payroll_period_get',
      'payroll_reconciliation_get',
      'payroll_tax_filing_get',
    ]);
    expect(resources.resources.map((resource) => resource.uri)).toEqual(['payroll://mcp/catalog']);
    expect(templates.resourceTemplates.map((template) => template.uriTemplate).sort()).toEqual([
      'payroll://payslips/self/{period}',
      'payroll://periods/{period}',
    ]);
    expect(prompts.prompts.map((prompt) => prompt.name).sort()).toEqual([
      'payroll_payslip_explain_self',
      'payroll_period_status_guide',
    ]);
    const result = await client.callTool({
      name: 'payroll_period_get',
      arguments: { period: '2026-07' },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ period: {
      payrollRunId: 'run-001',
      period: '2026-07',
      status: 'locked',
      employeeCount: 3,
      resultDigest: 'a'.repeat(64),
      version: 4,
    } });
  });
});
