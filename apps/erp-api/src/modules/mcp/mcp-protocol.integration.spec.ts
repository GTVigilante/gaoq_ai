import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ConfigService } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import type { ErpRequest } from '../../core/http/request-context.js';
import { McpController } from './mcp.controller.js';
import { McpRuntimeService } from './mcp-runtime.service.js';
import { McpToolService } from './mcp-tool.service.js';

describe('MCP Streamable HTTP 协议集成', () => {
  let app: INestApplication | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    if (client !== undefined) await client.close();
    if (app !== undefined) await app.close();
    client = undefined;
    app = undefined;
  });

  it('官方 MCP Client 可初始化、发现资源/工具并调用 R0 工具', async () => {
    const tools = {
      getMyPermissions: vi.fn().mockResolvedValue({
        content: [{ type: 'text' as const, text: '{"actorId":"employee-001"}' }],
        structuredContent: { actorId: 'employee-001' },
      }),
      getOrgChart: vi.fn().mockResolvedValue({
        content: [{ type: 'text' as const, text: '{"departments":[],"employees":[]}' }],
        structuredContent: { departments: [], employees: [] },
      }),
      prepareApprovalSubmit: vi.fn(),
      executeApprovalSubmit: vi.fn(),
      prepareApprovalWithdraw: vi.fn(),
      executeApprovalWithdraw: vi.fn(),
      prepareApprovalDecision: vi.fn(),
      executeApprovalDecision: vi.fn(),
      getRecruitmentApplication: vi.fn(),
      getRecruitmentRequisition: vi.fn(),
      getRecruitmentPosition: vi.fn(),
      getRecruitmentInterview: vi.fn(),
      getRecruitmentOffer: vi.fn().mockResolvedValue({
        content: [{ type: 'text' as const, text: JSON.stringify({
          offer: {
            id: '01J8ZQK7V0A2M4N6P8R0T2W4Y6',
            applicationId: '01J8ZQK7V0A2M4N6P8R0T2W4Y7',
            positionId: '01J8ZQK7V0A2M4N6P8R0T2W4Y8',
            completedInterviewId: '01J8ZQK7V0A2M4N6P8R0T2W4Y9',
            status: 'approved', expiresAt: '2026-08-01T00:00:00.000Z',
            approvalInstanceId: '01J8ZQK7V0A2M4N6P8R0T2W4Z0',
            sendRequestId: null, sentEvidenceId: null, acceptanceEvidenceId: null,
            esignFlowId: null, signedEvidenceId: null, version: 3,
          },
        }) }],
        structuredContent: { offer: {
          id: '01J8ZQK7V0A2M4N6P8R0T2W4Y6',
          applicationId: '01J8ZQK7V0A2M4N6P8R0T2W4Y7',
          positionId: '01J8ZQK7V0A2M4N6P8R0T2W4Y8',
          completedInterviewId: '01J8ZQK7V0A2M4N6P8R0T2W4Y9',
          status: 'approved', expiresAt: '2026-08-01T00:00:00.000Z',
          approvalInstanceId: '01J8ZQK7V0A2M4N6P8R0T2W4Z0',
          sendRequestId: null, sentEvidenceId: null, acceptanceEvidenceId: null,
          esignFlowId: null, signedEvidenceId: null, version: 3,
        } },
      }),
      getOnboarding: vi.fn().mockResolvedValue({
        content: [{ type: 'text' as const, text: JSON.stringify({
          onboarding: {
            id: '01J8ZQK7V0A2M4N6P8R0T2W4Y6',
            offerId: '01J8ZQK7V0A2M4N6P8R0T2W4Y7',
            applicationId: '01J8ZQK7V0A2M4N6P8R0T2W4Y8',
            candidateId: '01J8ZQK7V0A2M4N6P8R0T2W4Y9',
            departmentId: 'department-001', jobLevelId: 'level-001',
            orgPositionId: null, proposedStartDate: '2026-08-01',
            status: 'in_progress',
            tasks: {
              contract_archived: 'completed', identity_verified: 'pending',
              materials_verified: 'pending', org_assignment_verified: 'pending',
              mandatory_training_completed: 'pending',
            },
            employmentId: null, version: 1,
          },
        }) }],
        structuredContent: { onboarding: {
          id: '01J8ZQK7V0A2M4N6P8R0T2W4Y6',
          offerId: '01J8ZQK7V0A2M4N6P8R0T2W4Y7',
          applicationId: '01J8ZQK7V0A2M4N6P8R0T2W4Y8',
          candidateId: '01J8ZQK7V0A2M4N6P8R0T2W4Y9',
          departmentId: 'department-001', jobLevelId: 'level-001',
          orgPositionId: null, proposedStartDate: '2026-08-01', status: 'in_progress',
          tasks: {
            contract_archived: 'completed', identity_verified: 'pending',
            materials_verified: 'pending', org_assignment_verified: 'pending',
            mandatory_training_completed: 'pending',
          }, employmentId: null, version: 1,
        } },
      }),
      getKnowledgeCourse: vi.fn().mockResolvedValue({
        content: [{ type: 'text' as const, text: JSON.stringify({ course: {
          id: '01J8ZQK7V0A2M4N6P8R0T2W4A1', courseCode: 'SECURITY', revision: 1,
          title: '安全培训', examRequired: true, passingScoreBps: 8_000,
          status: 'published', version: 2,
        } }) }],
        structuredContent: { course: {
          id: '01J8ZQK7V0A2M4N6P8R0T2W4A1', courseCode: 'SECURITY', revision: 1,
          title: '安全培训', examRequired: true, passingScoreBps: 8_000,
          status: 'published', version: 2,
        } },
      }),
      getKnowledgeAssignment: vi.fn().mockResolvedValue({
        content: [{ type: 'text' as const, text: JSON.stringify({ assignment: {
          id: '01J8ZQK7V0A2M4N6P8R0T2W4A2',
          onboardingInstanceId: '01J8ZQK7V0A2M4N6P8R0T2W4Y6',
          courseVersionId: '01J8ZQK7V0A2M4N6P8R0T2W4A1', mandatory: true,
          examRequired: true, dueDate: '2026-08-31', status: 'in_progress',
          progressBps: 5_000, version: 2,
        } }) }],
        structuredContent: { assignment: {
          id: '01J8ZQK7V0A2M4N6P8R0T2W4A2',
          onboardingInstanceId: '01J8ZQK7V0A2M4N6P8R0T2W4Y6',
          courseVersionId: '01J8ZQK7V0A2M4N6P8R0T2W4A1', mandatory: true,
          examRequired: true, dueDate: '2026-08-31', status: 'in_progress',
          progressBps: 5_000, version: 2,
        } },
      }),
      getCareCase: vi.fn().mockResolvedValue({
        content: [{ type: 'text' as const, text: JSON.stringify({ careCase: {
          id: '01J8ZQK7V0A2M4N6P8R0T2W4C1',
          employeeId: '01J8ZQK7V0A2M4N6P8R0T2W4C2',
          employmentId: '01J8ZQK7V0A2M4N6P8R0T2W4C3',
          lastWorkingDate: '2026-07-31', accessDisableAt: '2026-07-31T10:00:00.000Z',
          status: 'clearing', tasks: {
            handover_accepted: 'completed', assets_cleared: 'pending',
            finance_cleared: 'pending', data_retention_confirmed: 'completed',
          }, version: 5,
        } }) }],
        structuredContent: { careCase: {
          id: '01J8ZQK7V0A2M4N6P8R0T2W4C1',
          employeeId: '01J8ZQK7V0A2M4N6P8R0T2W4C2',
          employmentId: '01J8ZQK7V0A2M4N6P8R0T2W4C3',
          lastWorkingDate: '2026-07-31', accessDisableAt: '2026-07-31T10:00:00.000Z',
          status: 'clearing', tasks: {
            handover_accepted: 'completed', assets_cleared: 'pending',
            finance_cleared: 'pending', data_retention_confirmed: 'completed',
          }, version: 5,
        } },
      }),
      getMyAttendanceMonth: vi.fn(),
      getPayrollPeriod: vi.fn(),
      getMyPayrollPayslip: vi.fn(),
      getPayrollTaxFiling: vi.fn(),
      prepareAttendanceCorrectionRequest: vi.fn(),
      executeAttendanceCorrectionRequest: vi.fn(),
      prepareRecruitmentRequisitionSubmit: vi.fn(),
      executeRecruitmentRequisitionSubmit: vi.fn(),
      prepareRecruitmentPositionTransition: vi.fn(),
      executeRecruitmentPositionTransition: vi.fn(),
      prepareRecruitmentOfferSend: vi.fn(),
      executeRecruitmentOfferSend: vi.fn(),
    };
    const module = await Test.createTestingModule({
      controllers: [McpController],
      providers: [
        McpRuntimeService,
        { provide: McpToolService, useValue: tools },
        {
          provide: ConfigService,
          useValue: new ConfigService<AppEnvironment, true>({
            MCP_ALLOWED_ORIGINS: 'https://trusted-ai.example.com',
          } as AppEnvironment),
        },
      ],
    }).compile();
    app = module.createNestApplication();
    let resourceUrl = 'http://127.0.0.1/mcp';
    app.use((request: ErpRequest, _response: Response, next: NextFunction) => {
      request.bearerToken = 'protocol-test-fixture';
      request.traceId = 'trace-protocol-001';
      request.verifiedAccessToken = {
        issuer: 'https://auth.example.com',
        subject: 'employee-001',
        audience: ['gaoq-erp'],
        resource: [resourceUrl],
        tenantId: 'tenant-001',
        actorId: 'employee-001',
        actorType: 'user',
        clientId: 'official-sdk-test-client',
        roleCodes: ['employee'],
        scopes: ['erp:mcp:server:connect', 'erp:org:chart:read'],
        departmentIds: ['department-001'],
        sessionId: 'session-001',
        expiresAt: 1_900_000_000,
      };
      next();
    });
    await app.listen(0, '127.0.0.1');
    resourceUrl = `${await app.getUrl()}/mcp`;

    client = new Client({ name: 'gaoq-protocol-integration', version: '0.1.0' });
    const exchanges: Array<Record<string, unknown>> = [];
    const diagnosticFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      exchanges.push({
        method: init?.method ?? 'GET',
        status: response.status,
      });
      return response;
    };
    const transport = new StreamableHTTPClientTransport(new URL(resourceUrl), {
      fetch: diagnosticFetch,
    });
    try {
      await client.connect(transport as unknown as Transport);
    } catch (error) {
      throw new Error(`MCP 初始化失败：${JSON.stringify(exchanges)}`, { cause: error });
    }
    expect(client.getServerCapabilities()?.extensions).toMatchObject({
      'io.modelcontextprotocol/oauth-client-credentials': {},
    });

    let listedTools;
    try {
      listedTools = await client.listTools();
    } catch (error) {
      throw new Error(`MCP 工具发现失败：${JSON.stringify(exchanges)}`, { cause: error });
    }
    expect(listedTools.tools.map((tool) => tool.name)).toEqual([
      'get_my_permissions',
      'approval_get_inbox',
      'approval_get',
      'approval_submit_prepare',
      'approval_submit_execute',
      'approval_withdraw_prepare',
      'approval_withdraw_execute',
      'approval_decide_prepare',
      'approval_decide_execute',
      'get_org_chart',
      'recruitment_application_get',
      'recruitment_requisition_get',
      'recruitment_position_get',
      'recruitment_interview_get',
      'recruitment_offer_get',
      'onboarding_get',
      'knowledge_course_get',
      'knowledge_assignment_get',
      'care_case_get',
      'attendance_month_get',
      'payroll_period_get',
      'payroll_payslip_get_self',
      'payroll_tax_filing_get',
      'attendance_correction_prepare',
      'attendance_correction_execute',
      'recruitment_requisition_submit_prepare',
      'recruitment_requisition_submit_execute',
      'recruitment_position_transition_prepare',
      'recruitment_position_transition_execute',
      'recruitment_offer_send_prepare',
      'recruitment_offer_send_execute',
    ]);
    const resources = await client.listResources();
    expect(resources.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ uri: 'gaoq://mcp/guide' }),
      expect.objectContaining({ uri: 'erp://approval/pending' }),
    ]));
    const resourceTemplates = await client.listResourceTemplates();
    expect(resourceTemplates.resourceTemplates).toEqual(expect.arrayContaining([
      expect.objectContaining({ uriTemplate: 'erp://recruitment/applications/{id}' }),
      expect.objectContaining({ uriTemplate: 'erp://recruitment/offers/{id}' }),
      expect.objectContaining({ uriTemplate: 'erp://onboarding/instances/{id}' }),
      expect.objectContaining({ uriTemplate: 'erp://knowledge/courses/{id}' }),
      expect.objectContaining({ uriTemplate: 'erp://knowledge/assignments/{id}' }),
      expect.objectContaining({ uriTemplate: 'erp://care/cases/{id}' }),
      expect.objectContaining({ uriTemplate: 'erp://attendance/months/{month}/me' }),
      expect.objectContaining({ uriTemplate: 'erp://payroll/periods/{id}' }),
      expect.objectContaining({ uriTemplate: 'erp://payroll/payslips/{period}/me' }),
      expect.objectContaining({ uriTemplate: 'erp://payroll/tax-filings/{id}' }),
    ]));
    const prompts = await client.listPrompts();
    expect(prompts.prompts).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'approval_submission_guide' }),
      expect.objectContaining({ name: 'recruitment_offer_send_guide' }),
      expect.objectContaining({ name: 'onboarding_progress_guide' }),
      expect.objectContaining({ name: 'knowledge_training_progress_guide' }),
      expect.objectContaining({ name: 'care_offboarding_progress_guide' }),
      expect.objectContaining({ name: 'attendance_month_review_guide' }),
      expect.objectContaining({ name: 'payroll_period_review_guide' }),
      expect.objectContaining({ name: 'payroll_payslip_review_guide' }),
      expect.objectContaining({ name: 'payroll_tax_filing_review_guide' }),
    ]));

    const result = await client.callTool({ name: 'get_org_chart', arguments: {} });
    expect(result.structuredContent).toEqual({ departments: [], employees: [] });
    expect(tools.getOrgChart).toHaveBeenCalledOnce();

    const offerResult = await client.callTool({
      name: 'recruitment_offer_get',
      arguments: { id: '01J8ZQK7V0A2M4N6P8R0T2W4Y6' },
    });
    expect(offerResult.structuredContent).toMatchObject({
      offer: { status: 'approved', version: 3 },
    });
    expect(JSON.stringify(offerResult)).not.toMatch(/salary|benefits|terms/iu);
    const offerResource = await client.readResource({
      uri: 'erp://recruitment/offers/01J8ZQK7V0A2M4N6P8R0T2W4Y6',
    });
    const firstContent = offerResource.contents[0];
    const resourceText = firstContent !== undefined && 'text' in firstContent
      ? firstContent.text
      : '{}';
    expect(JSON.parse(resourceText)).toMatchObject({
      offer: { status: 'approved', version: 3 },
    });
    expect(tools.getRecruitmentOffer).toHaveBeenCalledTimes(2);

    const onboardingResult = await client.callTool({
      name: 'onboarding_get',
      arguments: { id: '01J8ZQK7V0A2M4N6P8R0T2W4Y6' },
    });
    expect(onboardingResult.structuredContent).toMatchObject({
      onboarding: { status: 'in_progress', version: 1 },
    });
    expect(JSON.stringify(onboardingResult)).not.toMatch(/EvidenceId|contractText|identityDocument/iu);
    const onboardingResource = await client.readResource({
      uri: 'erp://onboarding/instances/01J8ZQK7V0A2M4N6P8R0T2W4Y6',
    });
    const onboardingContent = onboardingResource.contents[0];
    const onboardingText = onboardingContent !== undefined && 'text' in onboardingContent
      ? onboardingContent.text
      : '{}';
    expect(JSON.parse(onboardingText)).toMatchObject({
      onboarding: { tasks: { identity_verified: 'pending' } },
    });
    expect(tools.getOnboarding).toHaveBeenCalledTimes(2);

    const knowledgeResult = await client.callTool({
      name: 'knowledge_assignment_get',
      arguments: { id: '01J8ZQK7V0A2M4N6P8R0T2W4A2' },
    });
    expect(knowledgeResult.structuredContent).toMatchObject({
      assignment: { progressBps: 5_000, status: 'in_progress' },
    });
    const knowledgeResource = await client.readResource({
      uri: 'erp://knowledge/courses/01J8ZQK7V0A2M4N6P8R0T2W4A1',
    });
    const knowledgeContent = knowledgeResource.contents[0];
    const knowledgeText = knowledgeContent !== undefined && 'text' in knowledgeContent
      ? knowledgeContent.text
      : '{}';
    expect(JSON.parse(knowledgeText)).toMatchObject({ course: { status: 'published' } });
    expect(JSON.stringify([knowledgeResult, knowledgeResource])).not.toMatch(
      /questionBank|contentRef|submissionRef|EvidenceId|answer/iu,
    );
    expect(tools.getKnowledgeAssignment).toHaveBeenCalledOnce();
    expect(tools.getKnowledgeCourse).toHaveBeenCalledOnce();

    const careResult = await client.callTool({
      name: 'care_case_get',
      arguments: { id: '01J8ZQK7V0A2M4N6P8R0T2W4C1' },
    });
    expect(careResult.structuredContent).toMatchObject({
      careCase: { status: 'clearing', tasks: { assets_cleared: 'pending' } },
    });
    const careResource = await client.readResource({
      uri: 'erp://care/cases/01J8ZQK7V0A2M4N6P8R0T2W4C1',
    });
    expect(JSON.stringify([careResult, careResource])).not.toMatch(
      /reasonCode|separationType|approvalInstanceId|EvidenceId|execution/iu,
    );
    expect(tools.getCareCase).toHaveBeenCalledTimes(2);
  });
});
