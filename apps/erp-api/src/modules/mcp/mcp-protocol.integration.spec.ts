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
      getMarketingSideEffect: vi.fn().mockResolvedValue({
        content: [{ type: 'text' as const, text: JSON.stringify({
          sideEffect: {
            eventId: '01J8ZQK7V0A2M4N6P8R0T2W4Y0',
            kind: 'lead_notification',
            aggregateId: 'lead-001',
            aggregateVersion: 1,
            channel: 'email',
            status: 'dead',
            attempts: 1,
            deliveryAttempts: 6,
            nextAttemptAt: '2026-07-27T00:00:00.000Z',
            dispatchedAt: '2026-07-27T00:00:01.000Z',
            completedAt: '2026-07-27T00:01:00.000Z',
            lastErrorCode: 'MARKETING_NOTIFICATION_GATEWAY_FAILED',
          },
        }) }],
        structuredContent: {
          sideEffect: {
            eventId: '01J8ZQK7V0A2M4N6P8R0T2W4Y0',
            kind: 'lead_notification',
            aggregateId: 'lead-001',
            aggregateVersion: 1,
            channel: 'email',
            status: 'dead',
            attempts: 1,
            deliveryAttempts: 6,
            nextAttemptAt: '2026-07-27T00:00:00.000Z',
            dispatchedAt: '2026-07-27T00:00:01.000Z',
            completedAt: '2026-07-27T00:01:00.000Z',
            lastErrorCode: 'MARKETING_NOTIFICATION_GATEWAY_FAILED',
          },
        },
      }),
      getOrgChart: vi.fn().mockResolvedValue({
        content: [{ type: 'text' as const, text: '{"departments":[],"employees":[]}' }],
        structuredContent: { departments: [], employees: [] },
      }),
      getApprovalTemplateCatalog: vi.fn().mockResolvedValue({
        content: [{ type: 'text' as const, text: '{"templates":[]}' }],
        structuredContent: { templates: [] },
      }),
      getApprovalDelegations: vi.fn().mockResolvedValue({
        content: [{ type: 'text' as const, text: '{"delegations":[]}' }],
        structuredContent: { delegations: [] },
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
          questionMode: 'objective', timeLimitMinutes: 60, maxAttempts: 3,
          gradingPolicyVersion: 'objective-auto-v1', passingRule: 'score_threshold',
          gradingSlaMinutes: 5, manualReviewSlaMinutes: 1_440,
          manualReviewRequired: false,
          status: 'published', version: 2,
        } }) }],
        structuredContent: { course: {
          id: '01J8ZQK7V0A2M4N6P8R0T2W4A1', courseCode: 'SECURITY', revision: 1,
          title: '安全培训', examRequired: true, passingScoreBps: 8_000,
          questionMode: 'objective', timeLimitMinutes: 60, maxAttempts: 3,
          gradingPolicyVersion: 'objective-auto-v1', passingRule: 'score_threshold',
          gradingSlaMinutes: 5, manualReviewSlaMinutes: 1_440,
          manualReviewRequired: false,
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
      getKnowledgeExamRun: vi.fn().mockResolvedValue({
        content: [{ type: 'text' as const, text: JSON.stringify({ examRun: {
          id: '01J8ZQK7V0A2M4N6P8R0T2W4A3',
          assignmentId: '01J8ZQK7V0A2M4N6P8R0T2W4A2',
          courseVersionId: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
          attemptNumber: 1, questionMode: 'mixed',
          gradingPolicyVersion: 'mixed-v1', passingRule: 'all_required_sections',
          gradingSlaMinutes: 5, manualReviewSlaMinutes: 1_440,
          manualReviewRequired: true, status: 'pending_review',
          startedAt: '2026-07-27T00:00:00.000Z',
          deadlineAt: '2026-07-27T01:00:00.000Z',
          submittedAt: '2026-07-27T00:45:00.000Z',
          submissionReason: 'learner', timedOut: false,
          finalAttemptId: null, version: 4,
        } }) }],
        structuredContent: { examRun: {
          id: '01J8ZQK7V0A2M4N6P8R0T2W4A3',
          assignmentId: '01J8ZQK7V0A2M4N6P8R0T2W4A2',
          courseVersionId: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
          attemptNumber: 1, questionMode: 'mixed',
          gradingPolicyVersion: 'mixed-v1', passingRule: 'all_required_sections',
          gradingSlaMinutes: 5, manualReviewSlaMinutes: 1_440,
          manualReviewRequired: true, status: 'pending_review',
          startedAt: '2026-07-27T00:00:00.000Z',
          deadlineAt: '2026-07-27T01:00:00.000Z',
          submittedAt: '2026-07-27T00:45:00.000Z',
          submissionReason: 'learner', timedOut: false,
          finalAttemptId: null, version: 4,
        } },
      }),
      searchKnowledge: vi.fn().mockResolvedValue({
        content: [{ type: 'text' as const, text: JSON.stringify({
          items: [{
            course: {
              id: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
              courseCode: 'SECURITY',
              revision: 1,
              title: '安全培训',
              examRequired: true,
              passingScoreBps: 8_000,
              questionMode: 'objective',
              timeLimitMinutes: 60,
              maxAttempts: 3,
              gradingPolicyVersion: 'objective-auto-v1',
              passingRule: 'score_threshold',
              gradingSlaMinutes: 5,
              manualReviewSlaMinutes: 1_440,
              manualReviewRequired: false,
              status: 'published',
              version: 2,
            },
            snippetText: '企业信息安全基础',
            highlights: [{ start: 2, end: 6 }],
            scoreBps: 9_000,
            indexedAt: '2026-07-27T00:00:00.000Z',
          }],
          nextCursor: null,
        }) }],
        structuredContent: {
          items: [{
            course: {
              id: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
              courseCode: 'SECURITY',
              revision: 1,
              title: '安全培训',
              examRequired: true,
              passingScoreBps: 8_000,
              questionMode: 'objective',
              timeLimitMinutes: 60,
              maxAttempts: 3,
              gradingPolicyVersion: 'objective-auto-v1',
              passingRule: 'score_threshold',
              gradingSlaMinutes: 5,
              manualReviewSlaMinutes: 1_440,
              manualReviewRequired: false,
              status: 'published',
              version: 2,
            },
            snippetText: '企业信息安全基础',
            highlights: [{ start: 2, end: 6 }],
            scoreBps: 9_000,
            indexedAt: '2026-07-27T00:00:00.000Z',
          }],
          nextCursor: null,
        },
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
      getTalentLifecycle: vi.fn().mockResolvedValue({
        content: [{ type: 'text' as const, text: JSON.stringify({ lifecycle: {
          candidateId: '01J8ZQK7V0A2M4N6P8R0T2W4E1',
          stage: 'recruiting', currentApplicationStage: 'interview',
          employeeStatus: null, openFollowUpCount: 1,
          nextActionAt: '2026-07-28T08:00:00.000Z',
          updatedAt: '2026-07-27T08:00:00.000Z',
        } }) }],
        structuredContent: { lifecycle: {
          candidateId: '01J8ZQK7V0A2M4N6P8R0T2W4E1',
          stage: 'recruiting', currentApplicationStage: 'interview',
          employeeStatus: null, openFollowUpCount: 1,
          nextActionAt: '2026-07-28T08:00:00.000Z',
          updatedAt: '2026-07-27T08:00:00.000Z',
        } },
      }),
      getMyAttendanceMonth: vi.fn(),
      getPayrollPeriod: vi.fn(),
      getMyPayrollPayslip: vi.fn(),
      getPayrollTaxFiling: vi.fn(),
      getPayrollReconciliation: vi.fn(),
      getPayrollShadowCycle: vi.fn(),
      getPayrollCutoverReadiness: vi.fn(),
      getOpOperatingSummary: vi.fn().mockResolvedValue({
        content: [{ type: 'text' as const, text: JSON.stringify({ operatingSummary: {
          id: '01J8ZQK7V0A2M4N6P8R0T2W4D1', summaryDate: '2026-07-22', revision: 1,
          currency: 'CNY', metrics: {
            gmvMinor: 123_456, paidOrderCount: 12, refundMinor: 500,
            refundOrderCount: 1, activeCustomerCount: 8,
          }, payloadHash: 'o'.repeat(43), occurredAt: '2026-07-22T08:00:00.000Z',
          receivedAt: '2026-07-22T08:00:01.000Z',
        } }) }],
        structuredContent: { operatingSummary: {
          id: '01J8ZQK7V0A2M4N6P8R0T2W4D1', summaryDate: '2026-07-22', revision: 1,
          currency: 'CNY', metrics: {
            gmvMinor: 123_456, paidOrderCount: 12, refundMinor: 500,
            refundOrderCount: 1, activeCustomerCount: 8,
          }, payloadHash: 'o'.repeat(43), occurredAt: '2026-07-22T08:00:00.000Z',
          receivedAt: '2026-07-22T08:00:01.000Z',
        } },
      }),
      getOpApprovalBridge: vi.fn().mockResolvedValue({
        content: [{ type: 'text' as const, text: JSON.stringify({ approvalBridge: {
          externalEventId: 'op-approval-event-001', sourceDocumentType: 'purchase_order',
          sourceDocumentId: 'po-001', approvalInstanceId: '01J8ZQK7V0A2M4N6P8R0T2W4D2',
          templateCode: 'PURCHASE_ORDER', approvalStatus: 'running', approvalVersion: 2,
          completedAt: null, updatedAt: '2026-07-22T08:00:01.000Z',
        } }) }],
        structuredContent: { approvalBridge: {
          externalEventId: 'op-approval-event-001', sourceDocumentType: 'purchase_order',
          sourceDocumentId: 'po-001', approvalInstanceId: '01J8ZQK7V0A2M4N6P8R0T2W4D2',
          templateCode: 'PURCHASE_ORDER', approvalStatus: 'running', approvalVersion: 2,
          completedAt: null, updatedAt: '2026-07-22T08:00:01.000Z',
        } },
      }),
      getManagementDashboard: vi.fn().mockResolvedValue({
        content: [{ type: 'text' as const, text: JSON.stringify({ dashboard: {
          asOf: '2026-07-22',
          window: { from: '2026-06-23', to: '2026-07-22', timezone: 'Asia/Shanghai' },
          generatedAt: '2026-07-22T08:00:00.000Z',
          freshness: {
            transactional: 'live', operatingSummaryDate: '2026-07-22', payrollPeriod: '2026-06',
          },
          workforce: { activeHeadcount: 120, probationHeadcount: 8, suspendedHeadcount: 1 },
          approvals: { running: 9, overdue48h: 2, completed30d: 40, approvalRateBps: 8_500 },
          recruitment: {
            openPositionCount: 5, openHeadcount: 8, activeApplicationCount: 32, hired30d: 4,
          },
          learning: {
            mandatoryAssignments: 100, completedMandatoryAssignments: 88,
            expiredMandatoryAssignments: 3, completionRateBps: 8_800,
          },
          payroll: { period: '2026-06', status: 'locked', employeeCount: 120 },
          operating: {
            summaryDate: '2026-07-22', revision: 1, currency: 'CNY',
            gmvMinor: 123_456, paidOrderCount: 12, refundMinor: 500,
          },
          sources: [
            'org_employees', 'approval_instances', 'recruitment_positions',
            'recruitment_applications', 'knowledge_training_assignments',
            'payroll_periods', 'op_operating_summaries',
          ],
        } }) }],
        structuredContent: { dashboard: {
          asOf: '2026-07-22',
          window: { from: '2026-06-23', to: '2026-07-22', timezone: 'Asia/Shanghai' },
          generatedAt: '2026-07-22T08:00:00.000Z',
          freshness: {
            transactional: 'live', operatingSummaryDate: '2026-07-22', payrollPeriod: '2026-06',
          },
          workforce: { activeHeadcount: 120, probationHeadcount: 8, suspendedHeadcount: 1 },
          approvals: { running: 9, overdue48h: 2, completed30d: 40, approvalRateBps: 8_500 },
          recruitment: {
            openPositionCount: 5, openHeadcount: 8, activeApplicationCount: 32, hired30d: 4,
          },
          learning: {
            mandatoryAssignments: 100, completedMandatoryAssignments: 88,
            expiredMandatoryAssignments: 3, completionRateBps: 8_800,
          },
          payroll: { period: '2026-06', status: 'locked', employeeCount: 120 },
          operating: {
            summaryDate: '2026-07-22', revision: 1, currency: 'CNY',
            gmvMinor: 123_456, paidOrderCount: 12, refundMinor: 500,
          },
          sources: [
            'org_employees', 'approval_instances', 'recruitment_positions',
            'recruitment_applications', 'knowledge_training_assignments',
            'payroll_periods', 'op_operating_summaries',
          ],
        } },
      }),
      getAnalyticsExport: vi.fn().mockResolvedValue({
        content: [{ type: 'text' as const, text: JSON.stringify({ export: {
          id: '01J8ZQK7V0A2M4N6P8R0T2W4E1', asOf: '2026-07-22', format: 'json',
          status: 'queued', resourceUri: 'erp://analytics/exports/01J8ZQK7V0A2M4N6P8R0T2W4E1',
          contentHash: null, artifact: null, expiresAt: '2026-07-23T08:00:00.000Z',
        } }) }],
        structuredContent: { export: {
          id: '01J8ZQK7V0A2M4N6P8R0T2W4E1', asOf: '2026-07-22', format: 'json',
          status: 'queued', resourceUri: 'erp://analytics/exports/01J8ZQK7V0A2M4N6P8R0T2W4E1',
          contentHash: null, artifact: null, expiresAt: '2026-07-23T08:00:00.000Z',
        } },
      }),
      prepareManagementDashboardExport: vi.fn(),
      executeManagementDashboardExport: vi.fn(),
      getDataMigrationReport: vi.fn().mockResolvedValue({
        content: [{ type: 'text' as const, text: JSON.stringify({ report: {
          runId: '01J8ZQK7V0A2M4N6P8R0T2W4F1', sourceSystem: 'legacy-hr', mode: 'full',
          scope: 'org_reference', status: 'failed', expectedSourceCount: 100, checkpoint: 100,
          counts: { applied: 98, duplicate: 1, rejected: 1 },
          sourceChecksum: 's'.repeat(43), expectedSourceChecksum: 'e'.repeat(43),
          targetChecksum: 't'.repeat(43), associationCount: 20,
          unresolvedAssociationCount: 0, attachmentCount: 0, pendingAttachmentCount: 0,
          differences: [{ code: 'REJECTED_RECORDS', severity: 'critical', count: 1 }],
          phaseSixEligible: false,
        } }) }],
        structuredContent: { report: {
          runId: '01J8ZQK7V0A2M4N6P8R0T2W4F1', sourceSystem: 'legacy-hr', mode: 'full',
          scope: 'org_reference', status: 'failed', expectedSourceCount: 100, checkpoint: 100,
          counts: { applied: 98, duplicate: 1, rejected: 1 },
          sourceChecksum: 's'.repeat(43), expectedSourceChecksum: 'e'.repeat(43),
          targetChecksum: 't'.repeat(43), associationCount: 20,
          unresolvedAssociationCount: 0, attachmentCount: 0, pendingAttachmentCount: 0,
          differences: [{ code: 'REJECTED_RECORDS', severity: 'critical', count: 1 }],
          phaseSixEligible: false,
        } },
      }),
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
        scopes: [
          'erp:mcp:server:connect', 'erp:org:chart:read',
          'erp:approval:instance:submit',
          'erp:approval:delegation:read',
          'erp:op:operating_summary:read',
          'erp:analytics:management:read',
          'erp:analytics:management:export',
          'erp:migration:read',
          'erp:marketing:operations:read',
        ],
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
      'marketing_side_effect_get',
      'approval_get_inbox',
      'approval_get',
      'approval_timeline_get',
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
      'knowledge_exam_run_get',
      'knowledge_search',
      'care_case_get',
      'talent_lifecycle_get',
      'attendance_month_get',
      'payroll_period_get',
      'payroll_payslip_get_self',
      'payroll_tax_filing_get',
      'payroll_reconciliation_get',
      'payroll_shadow_cycle_get',
      'payroll_cutover_readiness_get',
      'op_operating_summary_get',
      'op_approval_bridge_get',
      'management_dashboard_get',
      'data_migration_report_get',
      'management_dashboard_export_prepare',
      'management_dashboard_export_execute',
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
      expect.objectContaining({ uri: 'erp://approval/templates/published' }),
      expect.objectContaining({ uri: 'erp://approval/delegations/mine' }),
    ]));
    const templateCatalog = await client.readResource({ uri: 'erp://approval/templates/published' });
    expect(templateCatalog.contents[0]).toMatchObject({
      uri: 'erp://approval/templates/published', mimeType: 'application/json', text: '{"templates":[]}',
    });
    expect(tools.getApprovalTemplateCatalog).toHaveBeenCalledOnce();
    const delegations = await client.readResource({ uri: 'erp://approval/delegations/mine' });
    expect(delegations.contents[0]).toMatchObject({
      uri: 'erp://approval/delegations/mine', mimeType: 'application/json', text: '{"delegations":[]}',
    });
    expect(tools.getApprovalDelegations).toHaveBeenCalledOnce();
    const resourceTemplates = await client.listResourceTemplates();
    expect(resourceTemplates.resourceTemplates).toEqual(expect.arrayContaining([
      expect.objectContaining({ uriTemplate: 'erp://recruitment/applications/{id}' }),
      expect.objectContaining({ uriTemplate: 'erp://recruitment/offers/{id}' }),
      expect.objectContaining({ uriTemplate: 'erp://onboarding/instances/{id}' }),
      expect.objectContaining({ uriTemplate: 'erp://knowledge/courses/{id}' }),
      expect.objectContaining({ uriTemplate: 'erp://knowledge/assignments/{id}' }),
      expect.objectContaining({ uriTemplate: 'erp://knowledge/exam-runs/{id}' }),
      expect.objectContaining({ uriTemplate: 'erp://knowledge/search/{query}' }),
      expect.objectContaining({ uriTemplate: 'erp://care/cases/{id}' }),
      expect.objectContaining({ uriTemplate: 'erp://talent-lifecycle/people/{candidateId}' }),
      expect.objectContaining({ uriTemplate: 'erp://attendance/months/{month}/me' }),
      expect.objectContaining({ uriTemplate: 'erp://payroll/periods/{id}' }),
      expect.objectContaining({ uriTemplate: 'erp://payroll/payslips/{period}/me' }),
      expect.objectContaining({ uriTemplate: 'erp://payroll/tax-filings/{id}' }),
      expect.objectContaining({ uriTemplate: 'erp://payroll/reconciliations/{id}' }),
      expect.objectContaining({ uriTemplate: 'erp://payroll/shadow-cycles/{id}' }),
      expect.objectContaining({ uriTemplate: 'erp://payroll/cutover-readiness/{id}' }),
      expect.objectContaining({ uriTemplate: 'erp://op/operating-summaries/{date}' }),
      expect.objectContaining({ uriTemplate: 'erp://op/approval-bridges/{externalEventId}' }),
      expect.objectContaining({ uriTemplate: 'erp://analytics/management-dashboard/{asOf}' }),
      expect.objectContaining({ uriTemplate: 'erp://analytics/exports/{id}' }),
      expect.objectContaining({ uriTemplate: 'erp://data-migrations/runs/{id}/report' }),
      expect.objectContaining({ uriTemplate: 'erp://marketing/side-effects/{eventId}' }),
    ]));
    const prompts = await client.listPrompts();
    expect(prompts.prompts).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'approval_submission_guide' }),
      expect.objectContaining({ name: 'recruitment_offer_send_guide' }),
      expect.objectContaining({ name: 'onboarding_progress_guide' }),
      expect.objectContaining({ name: 'knowledge_training_progress_guide' }),
      expect.objectContaining({ name: 'knowledge_exam_run_status_guide' }),
      expect.objectContaining({ name: 'knowledge_search_guide' }),
      expect.objectContaining({ name: 'care_offboarding_progress_guide' }),
      expect.objectContaining({ name: 'talent_lifecycle_follow_up_guide' }),
      expect.objectContaining({ name: 'attendance_month_review_guide' }),
      expect.objectContaining({ name: 'payroll_period_review_guide' }),
      expect.objectContaining({ name: 'payroll_payslip_review_guide' }),
      expect.objectContaining({ name: 'payroll_tax_filing_review_guide' }),
      expect.objectContaining({ name: 'payroll_reconciliation_review_guide' }),
      expect.objectContaining({ name: 'payroll_shadow_cycle_review_guide' }),
      expect.objectContaining({ name: 'payroll_cutover_readiness_review_guide' }),
      expect.objectContaining({ name: 'op_operating_summary_review_guide' }),
      expect.objectContaining({ name: 'op_approval_bridge_review_guide' }),
      expect.objectContaining({ name: 'management_dashboard_review_guide' }),
      expect.objectContaining({ name: 'data_migration_report_review_guide' }),
      expect.objectContaining({ name: 'marketing_side_effect_triage_guide' }),
    ]));

    const result = await client.callTool({ name: 'get_org_chart', arguments: {} });
    expect(result.structuredContent).toEqual({ departments: [], employees: [] });
    expect(tools.getOrgChart).toHaveBeenCalledOnce();

    const marketingResult = await client.callTool({
      name: 'marketing_side_effect_get',
      arguments: { eventId: '01J8ZQK7V0A2M4N6P8R0T2W4Y0' },
    });
    expect(marketingResult.structuredContent).toMatchObject({
      sideEffect: {
        status: 'dead',
        deliveryAttempts: 6,
      },
    });
    expect(JSON.stringify(marketingResult)).not.toMatch(/contact|requestSummary|tenantId/u);

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
    const examRunResult = await client.callTool({
      name: 'knowledge_exam_run_get',
      arguments: { id: '01J8ZQK7V0A2M4N6P8R0T2W4A3' },
    });
    expect(examRunResult.structuredContent).toMatchObject({
      examRun: { status: 'pending_review', manualReviewRequired: true },
    });
    expect(JSON.stringify(examRunResult)).not.toMatch(
      /questionBank|submissionRef|reviewEvidence|gatewaySession|answer/iu,
    );
    expect(tools.getKnowledgeExamRun).toHaveBeenCalledOnce();
    const searchResult = await client.callTool({
      name: 'knowledge_search',
      arguments: { query: '信息安全', limit: 10 },
    });
    expect(searchResult.structuredContent).toMatchObject({
      items: [{
        course: { id: '01J8ZQK7V0A2M4N6P8R0T2W4A1' },
        snippetText: '企业信息安全基础',
      }],
      nextCursor: null,
    });
    const searchResource = await client.readResource({
      uri: `erp://knowledge/search/${encodeURIComponent('信息安全')}`,
    });
    expect(JSON.stringify([searchResult, searchResource])).not.toMatch(
      /tenantId|employeeId|departmentIds|positionIds|contentRef|questionBank|answer/iu,
    );
    expect(tools.searchKnowledge).toHaveBeenCalledTimes(2);

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

    const lifecycleResult = await client.callTool({
      name: 'talent_lifecycle_get',
      arguments: { candidateId: '01J8ZQK7V0A2M4N6P8R0T2W4E1' },
    });
    expect(lifecycleResult.structuredContent).toMatchObject({
      lifecycle: { stage: 'recruiting', openFollowUpCount: 1 },
    });
    const lifecycleResource = await client.readResource({
      uri: 'erp://talent-lifecycle/people/01J8ZQK7V0A2M4N6P8R0T2W4E1',
    });
    expect(JSON.stringify([lifecycleResult, lifecycleResource])).not.toMatch(
      /displayName|phone|email|note|reasonCode|EvidenceId/iu,
    );
    expect(tools.getTalentLifecycle).toHaveBeenCalledTimes(2);

    const bridgeResult = await client.callTool({
      name: 'op_approval_bridge_get', arguments: { externalEventId: 'approval-event-001' },
    });
    expect(bridgeResult.structuredContent).toMatchObject({
      approvalBridge: { approvalStatus: 'running', approvalVersion: 2 },
    });
    const bridgeResource = await client.readResource({
      uri: 'erp://op/approval-bridges/approval-event-001',
    });
    expect(JSON.stringify([bridgeResult, bridgeResource])).not.toMatch(
      /formData|payloadCiphertext|comment|credential/iu,
    );
    expect(tools.getOpApprovalBridge).toHaveBeenCalledTimes(2);

    const dashboardResult = await client.callTool({
      name: 'management_dashboard_get', arguments: { asOf: '2026-07-22' },
    });
    expect(dashboardResult.structuredContent).toMatchObject({
      dashboard: {
        asOf: '2026-07-22', workforce: { activeHeadcount: 120 },
        approvals: { approvalRateBps: 8_500 },
      },
    });
    const dashboardResource = await client.readResource({
      uri: 'erp://analytics/management-dashboard/2026-07-22',
    });
    expect(JSON.stringify([dashboardResult, dashboardResource])).not.toMatch(
      /displayName|employeeNo|candidateId|salary|payslip|formData|comment/iu,
    );
    expect(tools.getManagementDashboard).toHaveBeenCalledTimes(2);

    const exportResource = await client.readResource({
      uri: 'erp://analytics/exports/01J8ZQK7V0A2M4N6P8R0T2W4E1',
    });
    const exportContent = exportResource.contents[0];
    const exportText = exportContent !== undefined && 'text' in exportContent
      ? exportContent.text : '{}';
    expect(JSON.parse(exportText)).toMatchObject({ export: { status: 'queued' } });
    expect(exportText).not.toMatch(/tenantId|requestedBy|failureCode/iu);
    expect(tools.getAnalyticsExport).toHaveBeenCalledOnce();

    const migrationResource = await client.readResource({
      uri: 'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/report',
    });
    const migrationContent = migrationResource.contents[0];
    const migrationText = migrationContent !== undefined && 'text' in migrationContent
      ? migrationContent.text : '{}';
    expect(JSON.parse(migrationText)).toMatchObject({
      report: { status: 'failed', phaseSixEligible: false },
    });
    expect(migrationText).not.toMatch(/payload|displayName|attachmentContent|tenantId/iu);
    expect(tools.getDataMigrationReport).toHaveBeenCalledOnce();
  });
});
