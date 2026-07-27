import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Response } from 'express';
import { z } from 'zod';

import type { AppEnvironment } from '../../config/environment.js';
import type { ErpRequest } from '../../core/http/request-context.js';
import { DATA_MIGRATION_SCOPES } from '../data-migration/data-migration-contract.js';
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
const approvalTimelineOutputSchema = z.object({
  timeline: z.array(z.object({
    actionId: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
    aggregateVersion: z.number().int().positive(),
    actionType: z.enum([
      'instance.submitted', 'instance.decided', 'instance.approver_transferred',
      'instance.approver_added', 'instance.withdrawn', 'instance.archived',
    ]),
    actorId: z.string(),
    principalApproverId: z.string().nullable(),
    nodeId: z.string().nullable(),
    outcome: z.enum(['approved', 'rejected']).nullable(),
    resultingStatus: z.enum(['draft', 'running', 'approved', 'rejected', 'withdrawn', 'archived']).nullable(),
    delegated: z.boolean(),
    fromApproverId: z.string().nullable(),
    toApproverId: z.string().nullable(),
    addedApproverId: z.string().nullable(),
    canceledApproverIds: z.array(z.string()),
    occurredAt: z.string(),
  })),
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
const marketingEventIdSchema = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const marketingSideEffectSchema = z.object({
  eventId: marketingEventIdSchema,
  kind: z.enum(['lead_notification', 'scheduled_publish']),
  aggregateId: z.string(),
  aggregateVersion: z.number().int().positive(),
  channel: z.enum(['email', 'feishu']).nullable(),
  status: z.enum([
    'pending', 'dispatching', 'dispatched', 'delivered', 'cancelled', 'dead',
  ]),
  attempts: z.number().int().nonnegative(),
  deliveryAttempts: z.number().int().nonnegative(),
  nextAttemptAt: z.string(),
  dispatchedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  lastErrorCode: z.string().nullable(),
});
const marketingSideEffectOutputSchema = z.object({
  sideEffect: marketingSideEffectSchema,
});
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
const onboardingTaskStatusSchema = z.enum(['pending', 'completed']);
const onboardingSchema = z.object({
  id: recruitmentIdSchema,
  offerId: recruitmentIdSchema,
  applicationId: recruitmentIdSchema,
  candidateId: recruitmentIdSchema,
  departmentId: z.string(),
  jobLevelId: z.string(),
  orgPositionId: z.string().nullable(),
  proposedStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.enum(['in_progress', 'ready', 'provisioning', 'completed', 'cancelled']),
  tasks: z.object({
    contract_archived: onboardingTaskStatusSchema,
    identity_verified: onboardingTaskStatusSchema,
    materials_verified: onboardingTaskStatusSchema,
    org_assignment_verified: onboardingTaskStatusSchema,
    mandatory_training_completed: onboardingTaskStatusSchema,
  }),
  employmentId: z.string().nullable(),
  version: z.number().int().positive(),
});
const knowledgeCourseSchema = z.object({
  id: z.string(), courseCode: z.string(), revision: z.number().int().positive(), title: z.string(),
  examRequired: z.boolean(), passingScoreBps: z.number().int().min(0).max(10_000).nullable(),
  status: z.enum(['draft', 'published', 'retired']), version: z.number().int().positive(),
});
const knowledgeAssignmentSchema = z.object({
  id: z.string(), onboardingInstanceId: z.string(), courseVersionId: z.string(),
  mandatory: z.boolean(), examRequired: z.boolean(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.enum(['assigned', 'in_progress', 'completed', 'expired']),
  progressBps: z.number().int().min(0).max(10_000), version: z.number().int().positive(),
});
const careTaskStatusSchema = z.enum(['pending', 'completed']);
const careCaseSchema = z.object({
  id: z.string(), employeeId: z.string(), employmentId: z.string(),
  lastWorkingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), accessDisableAt: z.string(),
  status: z.enum([
    'draft', 'pending_approval', 'approved', 'clearing', 'ready',
    'scheduled', 'executing', 'completed', 'cancelled',
  ]),
  tasks: z.object({
    handover_accepted: careTaskStatusSchema,
    assets_cleared: careTaskStatusSchema,
    finance_cleared: careTaskStatusSchema,
    data_retention_confirmed: careTaskStatusSchema,
  }),
  version: z.number().int().positive(),
});
const attendanceMonthSchema = z.object({
  id: z.string(), employeeId: z.string(), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  snapshotVersion: z.number().int().positive(), rulesetVersion: z.string(),
  sourceCutoffAt: z.string(), workedMinutes: z.number().int().nonnegative(),
  leaveMinutes: z.number().int().nonnegative(), overtimeMinutes: z.number().int().nonnegative(),
  absentMinutes: z.number().int().nonnegative(), sourceFactCount: z.number().int().nonnegative(),
  correctionCount: z.number().int().nonnegative(), snapshotHash: z.string().length(43),
  closedAt: z.string(),
});
const attendanceCorrectionRequestSchema = z.object({
  approvalInstanceId: recruitmentIdSchema,
  approvalStatus: z.enum(['running', 'approved']),
  approvalVersion: z.number().int().positive(),
  sourceFactId: recruitmentIdSchema,
  employeeId: z.string(),
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
const attendanceCorrectionInputSchema = {
  sourceFactId: recruitmentIdSchema,
  workedMinutes: z.number().int().min(0).max(44_640),
  leaveMinutes: z.number().int().min(0).max(44_640),
  overtimeMinutes: z.number().int().min(0).max(44_640),
  absentMinutes: z.number().int().min(0).max(44_640),
  reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
};
const payrollPeriodSchema = z.object({
  id: recruitmentIdSchema,
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  status: z.enum([
    'draft', 'collecting', 'review', 'pending_approval', 'approved',
    'locked', 'disbursing', 'reconciling', 'reconciled',
  ]),
  version: z.number().int().positive(),
  activeRunId: recruitmentIdSchema.nullable(),
  inputSnapshotHash: z.string().length(43).nullable(),
  resultHash: z.string().length(43).nullable(),
  employeeCount: z.number().int().positive().nullable(),
  totalGrossMinor: z.number().int().nonnegative().nullable(),
  totalTaxMinor: z.number().int().nullable(),
  totalNetMinor: z.number().int().nonnegative().nullable(),
});
const payrollComponentSchema = z.object({ code: z.string(), amountMinor: z.number().int().nonnegative() });
const payrollPayslipSchema = z.object({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), currency: z.literal('CNY'),
  taxableEarnings: z.array(payrollComponentSchema), nonTaxableEarnings: z.array(payrollComponentSchema),
  grossPayMinor: z.number().int().nonnegative(),
  employeeSocialInsuranceMinor: z.number().int().nonnegative(),
  employeeHousingFundMinor: z.number().int().nonnegative(),
  specialAdditionalDeductionMinor: z.number().int().nonnegative(),
  otherPreTaxWithholdingMinor: z.number().int().nonnegative(),
  postTaxDeductionMinor: z.number().int().nonnegative(), withholdingTaxMinor: z.number().int(),
  netPayMinor: z.number().int().nonnegative(), inputHash: z.string().length(43),
  resultHash: z.string().length(43), publishedAt: z.string(),
});
const payrollTaxFilingSchema = z.object({
  id: recruitmentIdSchema, periodId: recruitmentIdSchema,
  payrollRunId: recruitmentIdSchema,
  format: z.literal('CN_IIT_WITHHOLDING_MANIFEST_V1'),
  status: z.enum(['archiving', 'prepared', 'approved', 'submitting', 'submitted', 'rejected']),
  version: z.number().int().positive(), contentHash: z.string().length(43),
  employeeCount: z.number().int().min(1).max(5_000),
  totalTaxableEarningsMinor: z.number().int().nonnegative(),
  totalWithholdingTaxMinor: z.number().int(),
  objectEvidenceId: z.string().nullable(), taxSubmissionId: z.string().nullable(),
  taxSubmissionEvidenceId: z.string().nullable(),
});
const payrollReconciliationSchema = z.object({
  id: recruitmentIdSchema, periodId: recruitmentIdSchema, payrollRunId: recruitmentIdSchema,
  batchId: recruitmentIdSchema, bankReturnId: recruitmentIdSchema,
  taxFilingId: recruitmentIdSchema, status: z.enum(['balanced', 'frozen']),
  differences: z.array(z.enum([
    'PAYROLL_BANK_AMOUNT_MISMATCH', 'BANK_RETURN_AMOUNT_MISMATCH',
    'BANK_RETURN_COUNT_MISMATCH', 'PAYROLL_TAX_AMOUNT_MISMATCH',
    'PAYROLL_TAX_EMPLOYEE_COUNT_MISMATCH',
  ])).max(5),
  evidenceHash: z.string().length(43), employeeCount: z.number().int().min(1).max(5_000),
  bankLineCount: z.number().int().min(1).max(5_000),
  totalGrossMinor: z.number().int().nonnegative(), totalNetMinor: z.number().int().nonnegative(),
  bankSubmittedMinor: z.number().int().nonnegative(),
  bankReturnedMinor: z.number().int().nonnegative(),
  totalTaxableEarningsMinor: z.number().int().nonnegative(),
  payrollWithholdingTaxMinor: z.number().int(), filedWithholdingTaxMinor: z.number().int(),
  version: z.number().int().positive(),
});
const payrollShadowCycleSchema = z.object({
  id: recruitmentIdSchema, periodId: recruitmentIdSchema, payrollRunId: recruitmentIdSchema,
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), sourceSystem: z.string(),
  sourceManifestHash: z.string().length(43), payrollResultHash: z.string().length(43),
  comparisonHash: z.string().length(43),
  status: z.enum([
    'needs_explanation', 'ready_for_payroll_signoff', 'ready_for_finance_signoff', 'signed',
  ]),
  erpEmployeeCount: z.number().int().min(1).max(5_000),
  legacyEmployeeCount: z.number().int().min(1).max(5_000),
  erpTotalGrossMinor: z.number().int().nonnegative(),
  legacyTotalGrossMinor: z.number().int().nonnegative(),
  erpTotalTaxMinor: z.number().int(), legacyTotalTaxMinor: z.number().int(),
  erpTotalNetMinor: z.number().int().nonnegative(),
  legacyTotalNetMinor: z.number().int().nonnegative(),
  differenceCodes: z.array(z.enum([
    'LEGACY_EMPLOYEE_MISSING', 'ERP_EMPLOYEE_MISSING', 'GROSS_AMOUNT_MISMATCH',
    'WITHHOLDING_TAX_MISMATCH', 'NET_AMOUNT_MISMATCH',
  ])).max(5),
  differenceCount: z.number().int().nonnegative(),
  explainedDifferenceCount: z.number().int().nonnegative(),
  unresolvedDifferenceCount: z.number().int().nonnegative(),
  totalAbsoluteDifferenceMinor: z.number().int().nonnegative(),
  payrollSignoffId: recruitmentIdSchema.nullable(),
  financeSignoffId: recruitmentIdSchema.nullable(),
  cutoverReadinessId: recruitmentIdSchema.nullable(),
  version: z.number().int().positive(),
});
const payrollCutoverReadinessSchema = z.object({
  id: recruitmentIdSchema, firstCycleId: recruitmentIdSchema, secondCycleId: recruitmentIdSchema,
  startPeriod: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  endPeriod: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  evidenceHash: z.string().length(43), status: z.literal('eligible'),
  version: z.number().int().positive(),
});
const opOperatingSummarySchema = z.object({
  id: recruitmentIdSchema,
  summaryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  revision: z.number().int().positive(),
  currency: z.literal('CNY'),
  metrics: z.object({
    gmvMinor: z.number().int().nonnegative(),
    paidOrderCount: z.number().int().nonnegative(),
    refundMinor: z.number().int().nonnegative(),
    refundOrderCount: z.number().int().nonnegative(),
    activeCustomerCount: z.number().int().nonnegative(),
  }),
  payloadHash: z.string().length(43),
  occurredAt: z.string().datetime(),
  receivedAt: z.string().datetime(),
});
const opApprovalBridgeSchema = z.object({
  externalEventId: z.string(), sourceDocumentType: z.string(), sourceDocumentId: z.string(),
  approvalInstanceId: recruitmentIdSchema, templateCode: z.string(),
  approvalStatus: z.enum(['processing', 'running', 'approved', 'rejected', 'withdrawn']),
  approvalVersion: z.number().int().nonnegative(), completedAt: z.string().nullable(),
  updatedAt: z.string(),
});
const managementDashboardSchema = z.object({
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  window: z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), timezone: z.literal('Asia/Shanghai'),
  }),
  generatedAt: z.string().datetime(),
  freshness: z.object({
    transactional: z.literal('live'),
    operatingSummaryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    payrollPeriod: z.string().regex(/^\d{4}-\d{2}$/).nullable(),
  }),
  workforce: z.object({
    activeHeadcount: z.number().int().nonnegative(),
    probationHeadcount: z.number().int().nonnegative(),
    suspendedHeadcount: z.number().int().nonnegative(),
  }),
  approvals: z.object({
    running: z.number().int().nonnegative(), overdue48h: z.number().int().nonnegative(),
    completed30d: z.number().int().nonnegative(),
    approvalRateBps: z.number().int().min(0).max(10_000).nullable(),
  }),
  recruitment: z.object({
    openPositionCount: z.number().int().nonnegative(),
    openHeadcount: z.number().int().nonnegative(),
    activeApplicationCount: z.number().int().nonnegative(),
    hired30d: z.number().int().nonnegative(),
  }),
  learning: z.object({
    mandatoryAssignments: z.number().int().nonnegative(),
    completedMandatoryAssignments: z.number().int().nonnegative(),
    expiredMandatoryAssignments: z.number().int().nonnegative(),
    completionRateBps: z.number().int().min(0).max(10_000).nullable(),
  }),
  payroll: z.object({
    period: z.string().regex(/^\d{4}-\d{2}$/).nullable(),
    status: z.enum([
      'draft', 'collecting', 'review', 'pending_approval', 'approved',
      'locked', 'disbursing', 'reconciling', 'reconciled',
    ]).nullable(),
    employeeCount: z.number().int().nonnegative().nullable(),
  }),
  operating: z.object({
    summaryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    revision: z.number().int().positive().nullable(), currency: z.literal('CNY').nullable(),
    gmvMinor: z.number().int().nonnegative().nullable(),
    paidOrderCount: z.number().int().nonnegative().nullable(),
    refundMinor: z.number().int().nonnegative().nullable(),
  }),
  sources: z.array(z.string()).max(16),
});
const analyticsExportSchema = z.object({
  id: recruitmentIdSchema,
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  format: z.literal('json'),
  status: z.enum(['queued', 'processing', 'ready', 'failed']),
  resourceUri: z.string().regex(/^erp:\/\/analytics\/exports\/[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
  contentHash: z.string().length(43).nullable(),
  artifact: z.record(z.string(), z.unknown()).nullable(),
  expiresAt: z.string().datetime(),
});
const dataMigrationReportSchema = z.object({
  runId: recruitmentIdSchema, sourceSystem: z.string(),
  mode: z.enum(['full', 'incremental']), scope: z.enum(DATA_MIGRATION_SCOPES),
  status: z.enum(['running', 'completed', 'failed']),
  expectedSourceCount: z.number().int().nonnegative(), checkpoint: z.number().int().nonnegative(),
  counts: z.object({
    applied: z.number().int().nonnegative(), duplicate: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
  }),
  sourceChecksum: z.string().length(43), expectedSourceChecksum: z.string().length(43),
  targetChecksum: z.string().length(43), associationCount: z.number().int().nonnegative(),
  unresolvedAssociationCount: z.number().int().nonnegative(),
  attachmentCount: z.number().int().nonnegative(),
  pendingAttachmentCount: z.number().int().nonnegative(),
  differences: z.array(z.object({
    code: z.string(), severity: z.enum(['critical', 'high']),
    count: z.number().int().positive(),
  })),
  phaseSixEligible: z.boolean(),
});

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
    const mcpServer = this.createMcpServer();
    await mcpServer.connect(transport);
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
      await mcpServer.close();
    }
  }

  private createMcpServer(): McpServer {
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
      'approval-published-templates',
      'erp://approval/templates/published',
      {
        title: '可发起审批模板目录',
        description: '返回已发布模板的字段白名单；不包含流程节点、审批人、租户或表单数据。',
        mimeType: 'application/json',
      },
      async (uri, extra) => {
        const result = await this.tools.getApprovalTemplateCatalog(extra);
        if (result.isError === true) throw new Error('无权读取审批模板目录');
        return { contents: [{
          uri: uri.toString(),
          mimeType: 'application/json',
          text: JSON.stringify(result.structuredContent ?? { templates: [] }),
        }] };
      },
    );

    server.registerResource(
      'approval-delegations-mine',
      'erp://approval/delegations/mine',
      {
        title: '我的审批委托',
        description: '返回当前主体创建或承接的限期委托；AI 不可创建、修改或撤销授权关系。',
        mimeType: 'application/json',
      },
      async (uri, extra) => {
        const result = await this.tools.getApprovalDelegations(extra);
        if (result.isError === true) throw new Error('无权读取审批委托');
        return { contents: [{
          uri: uri.toString(),
          mimeType: 'application/json',
          text: JSON.stringify(result.structuredContent ?? { delegations: [] }),
        }] };
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

    server.registerResource(
      'onboarding-instance',
      new ResourceTemplate('erp://onboarding/instances/{id}', { list: undefined }),
      {
        title: '入职进度摘要',
        description: '读取任务完成状态和组织引用；不返回身份材料、合同、培训内容或证据原文。',
        mimeType: 'application/json',
      },
      async (uri, { id }, extra) => {
        const result = await this.tools.getOnboarding(requiredResourceId(id), extra);
        if (result.isError === true) throw new Error('无权读取入职实例');
        return { contents: [{
          uri: uri.toString(), mimeType: 'application/json',
          text: JSON.stringify(result.structuredContent ?? {}),
        }] };
      },
    );

    server.registerResource(
      'knowledge-course',
      new ResourceTemplate('erp://knowledge/courses/{id}', { list: undefined }),
      {
        title: '课程版本脱敏摘要',
        description: '读取课程发布和考试配置状态；不返回内容、题库、答案或证据引用。',
        mimeType: 'application/json',
      },
      async (uri, { id }, extra) => {
        const result = await this.tools.getKnowledgeCourse(requiredResourceId(id), extra);
        if (result.isError === true) throw new Error('无权读取课程版本');
        return { contents: [{
          uri: uri.toString(), mimeType: 'application/json',
          text: JSON.stringify(result.structuredContent ?? {}),
        }] };
      },
    );

    server.registerResource(
      'knowledge-assignment',
      new ResourceTemplate('erp://knowledge/assignments/{id}', { list: undefined }),
      {
        title: '培训任务脱敏摘要',
        description: '读取进度和状态；不返回考试提交、评分证据或完成证据引用。',
        mimeType: 'application/json',
      },
      async (uri, { id }, extra) => {
        const result = await this.tools.getKnowledgeAssignment(requiredResourceId(id), extra);
        if (result.isError === true) throw new Error('无权读取培训任务');
        return { contents: [{
          uri: uri.toString(), mimeType: 'application/json',
          text: JSON.stringify(result.structuredContent ?? {}),
        }] };
      },
    );

    server.registerResource(
      'care-case',
      new ResourceTemplate('erp://care/cases/{id}', { list: undefined }),
      {
        title: '离职案件脱敏进度',
        description: '读取清算任务与生效状态；不返回离职原因、审批正文或任何证据引用。',
        mimeType: 'application/json',
      },
      async (uri, { id }, extra) => {
        const result = await this.tools.getCareCase(requiredResourceId(id), extra);
        if (result.isError === true) throw new Error('无权读取离职案件');
        return { contents: [{
          uri: uri.toString(), mimeType: 'application/json',
          text: JSON.stringify(result.structuredContent ?? {}),
        }] };
      },
    );

    server.registerResource(
      'my-attendance-month',
      new ResourceTemplate('erp://attendance/months/{month}/me', { list: undefined }),
      {
        title: '我的考勤月结摘要',
        description: '只返回当前已验证员工的月度汇总；不返回打卡时间、地点、设备或修订原因。',
        mimeType: 'application/json',
      },
      async (uri, { month }, extra) => {
        const result = await this.tools.getMyAttendanceMonth(requiredMonth(month), extra);
        if (result.isError === true) throw new Error('无权读取本人考勤月结');
        return { contents: [{
          uri: uri.toString(), mimeType: 'application/json',
          text: JSON.stringify(result.structuredContent ?? {}),
        }] };
      },
    );

    server.registerResource(
      'payroll-period',
      new ResourceTemplate('erp://payroll/periods/{id}', { list: undefined }),
      {
        title: '工资周期脱敏汇总',
        description: '只返回周期状态、人数、总额与完整性摘要，不返回员工明细或薪酬档案。',
        mimeType: 'application/json',
      },
      async (uri, { id }, extra) => {
        const result = await this.tools.getPayrollPeriod(requiredResourceId(id), extra);
        if (result.isError === true) throw new Error('无权读取工资周期');
        return { contents: [{
          uri: uri.toString(), mimeType: 'application/json',
          text: JSON.stringify(result.structuredContent ?? {}),
        }] };
      },
    );

    server.registerResource(
      'my-payroll-payslip',
      new ResourceTemplate('erp://payroll/payslips/{period}/me', { list: undefined }),
      {
        title: '我的已发布薪资单',
        description: '只按当前已验证员工返回已锁定月份的本人薪资单；属于 L4 数据。',
        mimeType: 'application/json',
      },
      async (uri, { period }, extra) => {
        const result = await this.tools.getMyPayrollPayslip(requiredMonth(period), extra);
        if (result.isError === true) throw new Error('无权读取本人薪资单');
        return { contents: [{
          uri: uri.toString(), mimeType: 'application/json',
          text: JSON.stringify(result.structuredContent ?? {}),
        }] };
      },
    );

    server.registerResource(
      'payroll-tax-filing',
      new ResourceTemplate('erp://payroll/tax-filings/{id}', { list: undefined }),
      {
        title: '个税申报脱敏控制摘要',
        description: '只返回状态、控制总额、摘要与证据标识，不返回税务正文、身份凭证或 WORM 对象地址。',
        mimeType: 'application/json',
      },
      async (uri, { id }, extra) => {
        const result = await this.tools.getPayrollTaxFiling(requiredResourceId(id), extra);
        if (result.isError === true) throw new Error('无权读取个税申报状态');
        return { contents: [{
          uri: uri.toString(), mimeType: 'application/json',
          text: JSON.stringify(result.structuredContent ?? {}),
        }] };
      },
    );

    server.registerResource(
      'payroll-reconciliation',
      new ResourceTemplate('erp://payroll/reconciliations/{id}', { list: undefined }),
      {
        title: '工资四方对账控制摘要',
        description: '只返回工资、代发、回盘和个税控制量及标准差异码，不返回员工、账户或外部正文。',
        mimeType: 'application/json',
      },
      async (uri, { id }, extra) => {
        const result = await this.tools.getPayrollReconciliation(requiredResourceId(id), extra);
        if (result.isError === true) throw new Error('无权读取四方对账摘要');
        return { contents: [{
          uri: uri.toString(), mimeType: 'application/json',
          text: JSON.stringify(result.structuredContent ?? {}),
        }] };
      },
    );

    server.registerResource(
      'payroll-shadow-cycle',
      new ResourceTemplate('erp://payroll/shadow-cycles/{id}', { list: undefined }),
      {
        title: '工资影子周期脱敏控制摘要',
        description: '只返回新旧工资控制量、标准差异码、解释进度和签署状态，不返回员工级差异。',
        mimeType: 'application/json',
      },
      async (uri, { id }, extra) => {
        const result = await this.tools.getPayrollShadowCycle(requiredResourceId(id), extra);
        if (result.isError === true) throw new Error('无权读取工资影子周期');
        return { contents: [{
          uri: uri.toString(), mimeType: 'application/json',
          text: JSON.stringify(result.structuredContent ?? {}),
        }] };
      },
    );

    server.registerResource(
      'payroll-cutover-readiness',
      new ResourceTemplate('erp://payroll/cutover-readiness/{id}', { list: undefined }),
      {
        title: '工资两期可切换资格证据',
        description: '只返回连续两期签署范围与证据摘要；该资源不代表已经切换事实源。',
        mimeType: 'application/json',
      },
      async (uri, { id }, extra) => {
        const result = await this.tools.getPayrollCutoverReadiness(requiredResourceId(id), extra);
        if (result.isError === true) throw new Error('无权读取工资可切换资格');
        return { contents: [{
          uri: uri.toString(), mimeType: 'application/json',
          text: JSON.stringify(result.structuredContent ?? {}),
        }] };
      },
    );

    server.registerResource(
      'op-operating-summary',
      new ResourceTemplate('erp://op/operating-summaries/{date}', { list: undefined }),
      {
        title: 'OP 每日经营摘要',
        description: '只返回固定白名单经营指标与来源摘要；不参与工资、税务、资金或会计计算。',
        mimeType: 'application/json',
      },
      async (uri, { date }, extra) => {
        const result = await this.tools.getOpOperatingSummary(requiredDate(date), extra);
        if (result.isError === true) throw new Error('无权读取 OP 经营摘要');
        return { contents: [{
          uri: uri.toString(), mimeType: 'application/json',
          text: JSON.stringify(result.structuredContent ?? {}),
        }] };
      },
    );

    server.registerResource(
      'op-approval-bridge',
      new ResourceTemplate('erp://op/approval-bridges/{externalEventId}', { list: undefined }),
      {
        title: 'OP 来源审批状态',
        description: '只返回 OP 来源单据与 ERP 审批的控制关联和状态，不返回表单正文。',
        mimeType: 'application/json',
      },
      async (uri, { externalEventId }, extra) => {
        const result = await this.tools.getOpApprovalBridge(
          requiredExternalEventId(externalEventId), extra,
        );
        if (result.isError === true) throw new Error('无权读取 OP 审批关联');
        return { contents: [{
          uri: uri.toString(), mimeType: 'application/json',
          text: JSON.stringify(result.structuredContent ?? {}),
        }] };
      },
    );

    server.registerResource(
      'management-dashboard',
      new ResourceTemplate('erp://analytics/management-dashboard/{asOf}', { list: undefined }),
      {
        title: '管理驾驶舱',
        description: '固定口径的组织、审批、招聘、培训、薪资周期和 OP 聚合指标，不含个人明细。',
        mimeType: 'application/json',
      },
      async (uri, { asOf }, extra) => {
        const result = await this.tools.getManagementDashboard(requiredDate(asOf), extra);
        if (result.isError === true) throw new Error('无权读取管理驾驶舱');
        return { contents: [{
          uri: uri.toString(), mimeType: 'application/json',
          text: JSON.stringify(result.structuredContent ?? {}),
        }] };
      },
    );

    server.registerResource(
      'management-dashboard-export',
      new ResourceTemplate('erp://analytics/exports/{id}', { list: undefined }),
      {
        title: '管理驾驶舱异步导出',
        description: '返回当前用户经 R2 确认发起的固定聚合导出状态；就绪后包含 JSON 产物。',
        mimeType: 'application/json',
      },
      async (uri, { id }, extra) => {
        const result = await this.tools.getAnalyticsExport(requiredResourceId(id), extra);
        if (result.isError === true) throw new Error('无权读取管理驾驶舱导出');
        return { contents: [{
          uri: uri.toString(), mimeType: 'application/json',
          text: JSON.stringify(result.structuredContent ?? {}),
        }] };
      },
    );

    server.registerResource(
      'data-migration-report',
      new ResourceTemplate('erp://data-migrations/runs/{id}/report', { list: undefined }),
      {
        title: '数据迁移差异报告',
        description: '只读返回数量、校验和、拒绝、重复、关联与附件控制量，不返回来源正文。',
        mimeType: 'application/json',
      },
      async (uri, { id }, extra) => {
        const result = await this.tools.getDataMigrationReport(requiredResourceId(id), extra);
        if (result.isError === true) throw new Error('无权读取数据迁移报告');
        return { contents: [{
          uri: uri.toString(), mimeType: 'application/json',
          text: JSON.stringify(result.structuredContent ?? {}),
        }] };
      },
    );

    server.registerResource(
      'marketing-side-effect-status',
      new ResourceTemplate('erp://marketing/side-effects/{eventId}', { list: undefined }),
      {
        title: '营销副作用可靠性状态',
        description: '只读返回当前租户通知或排期副作用的路由、尝试次数和终态；不返回联系人或正文。',
        mimeType: 'application/json',
      },
      async (uri, { eventId }, extra) => {
        const result = await this.tools.getMarketingSideEffect(
          requiredMarketingEventId(eventId),
          extra,
        );
        if (result.isError === true) throw new Error('无权读取营销副作用状态');
        return { contents: [{
          uri: uri.toString(),
          mimeType: 'application/json',
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
      'marketing_side_effect_triage_guide',
      {
        title: '营销副作用故障核对清单',
        description: '指导 AI 只读解释通知与排期副作用状态，不代替用户执行 R2 重放。',
        argsSchema: { eventId: marketingEventIdSchema },
      },
      ({ eventId }) => ({ messages: [{ role: 'user', content: {
        type: 'text',
        text: `请读取营销副作用 ${eventId}，核对类型、渠道、入队/送达尝试、受控错误码和最终状态。不得索取或复述联系人、正文、凭据或上游响应；不得调用人工重放接口。若状态为 dead，只说明需要具备 R2 权限的人员在 ERP 审计页面复核。`,
      } }] }),
    );

    server.registerPrompt(
      'op_approval_bridge_review_guide',
      {
        title: 'OP 来源审批状态核对清单',
        description: '指导 AI 只核对来源单据、审批状态和回推控制信息，不读取表单或执行审批。',
        argsSchema: {
          externalEventId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        },
      },
      ({ externalEventId }) => ({ messages: [{ role: 'user', content: {
        type: 'text',
        text: `请读取 OP 审批事件 ${externalEventId} 的桥接状态，说明 ERP 审批实例、当前状态和版本。不要读取或复述表单正文，不要代替审批人决策，也不要触发重试或回推。`,
      } }] }),
    );

    server.registerPrompt(
      'management_dashboard_review_guide',
      {
        title: '管理驾驶舱解读清单',
        description: '指导 AI 核对口径、时间窗、数据覆盖与守护指标，不推断个人表现。',
        argsSchema: { asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) },
      },
      ({ asOf }) => ({ messages: [{ role: 'user', content: {
        type: 'text',
        text: `请读取 ${asOf} 管理驾驶舱。先说明 30 日窗口、来源集合和空值，再概括在岗规模、审批积压、招聘供给、必修培训、薪资周期与 OP 经营摘要。不得推断个人绩效，不得把相关性表述为因果，也不得触发导出。`,
      } }] }),
    );

    server.registerPrompt(
      'data_migration_report_review_guide',
      {
        title: '数据迁移差异报告核对清单',
        description: '指导 AI 解释数据质量门禁，不允许豁免差异或推进切换。',
        argsSchema: { runId: recruitmentIdSchema },
      },
      ({ runId }) => ({ messages: [{ role: 'user', content: {
        type: 'text',
        text: `请读取迁移运行 ${runId} 的差异报告，逐项说明来源数量、检查点、重复、拒绝、关联、附件和校验和。不得展示来源正文，不得把 failed 解释为可上线，不得代替数据负责人豁免差异或触发迁移。`,
      } }] }),
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

    server.registerPrompt(
      'onboarding_progress_guide',
      {
        title: '入职进度检查清单',
        description: '指导 AI 只读取脱敏任务状态；R3 建档和受信任证明不允许 AI 执行。',
        argsSchema: { onboardingId: recruitmentIdSchema },
      },
      ({ onboardingId }) => ({
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `请读取入职实例 ${onboardingId} 的任务状态，列出仍待完成的项目。不要索取身份证、合同、材料或培训正文；不要代报任务完成，也不要尝试执行劳动关系建档。`,
          },
        }],
      }),
    );

    server.registerPrompt(
      'knowledge_training_progress_guide',
      {
        title: '培训进度检查清单',
        description: '指导 AI 只读取课程与任务摘要，不接触答案、题库和可信证明写入。',
        argsSchema: { assignmentId: recruitmentIdSchema },
      },
      ({ assignmentId }) => ({
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `请读取培训任务 ${assignmentId} 的脱敏摘要，说明进度、截止日期和状态。不要索取课程正文、题库、答案、答卷或证据；不要代替评分、完成任务或回填入职证明。`,
          },
        }],
      }),
    );

    server.registerPrompt(
      'care_offboarding_progress_guide',
      {
        title: '离职清算进度检查清单',
        description: '只读取脱敏清算状态；AI 不审批、不代报证据、不执行离职或账号停用。',
        argsSchema: { careCaseId: recruitmentIdSchema },
      },
      ({ careCaseId }) => ({
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `请读取离职案件 ${careCaseId} 的脱敏任务状态，列出待办和计划生效时间。不要索取离职原因、审批正文、交接材料或证据；不要代报清算完成，也不要执行劳动关系关闭或身份停用。`,
          },
        }],
      }),
    );

    server.registerPrompt(
      'attendance_month_review_guide',
      {
        title: '本人考勤月结核对清单',
        description: '指导 AI 仅解释本人月度汇总；修订和重开必须进入 ERP 审批流程。',
        argsSchema: { month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) },
      },
      ({ month }) => ({
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `请读取我 ${month} 的考勤月结摘要，解释各分钟汇总和快照版本。不要索取或推断打卡时间、地点或设备；若我明确提供源事实标识、替换分钟和受控原因码，可调用 attendance_correction_prepare，并引导我在 ERP 确认页核对后再执行。AI 不得直接改事实、审批申请或重开月结。`,
          },
        }],
      }),
    );

    server.registerPrompt(
      'payroll_period_review_guide',
      {
        title: '工资周期汇总核对清单',
        description: '指导 AI 只核对周期状态、总额与摘要；不读取明细或执行任何工资写操作。',
        argsSchema: { periodId: recruitmentIdSchema },
      },
      ({ periodId }) => ({
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `请读取工资周期 ${periodId} 的脱敏汇总，说明状态、人数、总额和输入/结果摘要是否齐全。不要索取、推断或展示任何员工薪酬明细；不得触发规则发布、薪酬登记、工资计算、审批、锁定、代发或对账。`,
          },
        }],
      }),
    );

    server.registerPrompt(
      'payroll_payslip_review_guide',
      {
        title: '本人薪资单核对清单',
        description: '指导 AI 只解释本人已发布薪资单，不推断他人薪酬或触发写操作。',
        argsSchema: { period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) },
      },
      ({ period }) => ({ messages: [{ role: 'user', content: {
        type: 'text',
        text: `请读取我 ${period} 的已发布薪资单，解释收入、个人扣款、预扣税和实发。不得推断或比较他人薪酬，不得触发重算、审批、锁定、导出或发薪。`,
      } }] }),
    );

    server.registerPrompt(
      'payroll_tax_filing_review_guide',
      {
        title: '个税申报控制摘要核对清单',
        description: '指导 AI 核对状态、控制总额与证据链，不触发制备、审批或提交。',
        argsSchema: { filingId: recruitmentIdSchema },
      },
      ({ filingId }) => ({ messages: [{ role: 'user', content: {
        type: 'text',
        text: `请读取个税申报 ${filingId} 的脱敏控制摘要，核对状态、版本、人数、计税收入、预扣税、内容摘要和证据标识是否齐全。不得索取税务正文、员工身份、证件或 WORM 对象地址；不得触发制备、强认证审批或税局提交。`,
      } }] }),
    );

    server.registerPrompt(
      'payroll_reconciliation_review_guide',
      {
        title: '工资四方对账差异分析指南',
        description: '指导 AI 解释标准差异码和控制量，不执行解冻、补发或重报。',
        argsSchema: { reconciliationId: recruitmentIdSchema },
      },
      ({ reconciliationId }) => ({ messages: [{ role: 'user', content: {
        type: 'text',
        text: `请读取四方对账 ${reconciliationId} 的脱敏摘要，逐项解释工资净额、银行提交、终态回盘、工资税额和已申报税额是否守恒。仅依据标准差异码提出调查方向；不得索取员工、账户、证件、银行文件或税务正文，不得执行解冻、补发、重报或修改证据。`,
      } }] }),
    );

    server.registerPrompt(
      'payroll_shadow_cycle_review_guide',
      {
        title: '工资影子周期差异核对指南',
        description: '指导 AI 只读检查新旧工资控制量、标准差异与签署门禁。',
        argsSchema: { cycleId: recruitmentIdSchema },
      },
      ({ cycleId }) => ({ messages: [{ role: 'user', content: {
        type: 'text',
        text: `请读取工资影子周期 ${cycleId} 的脱敏摘要，核对新旧人数、工资总额、税额、实发额、标准差异码、已解释/未解释数量及财务签署状态。不得索取员工级差异、薪酬明细、解释正文或 WORM 地址；不得导入、归因、签署或切换事实源。`,
      } }] }),
    );

    server.registerPrompt(
      'payroll_cutover_readiness_review_guide',
      {
        title: '工资两期可切换资格核对指南',
        description: '指导 AI 只读验证连续两期证据，不执行 Go/No-Go 或系统切换。',
        argsSchema: { readinessId: recruitmentIdSchema },
      },
      ({ readinessId }) => ({ messages: [{ role: 'user', content: {
        type: 'text',
        text: `请读取工资可切换资格 ${readinessId}，核对两个影子周期是否连续、证据摘要和状态是否完整。该资格只是 Phase 4 门禁证据，不代表总体 Go/No-Go 已通过；不得执行连接切换、真实代发或修改证据。`,
      } }] }),
    );

    server.registerPrompt(
      'op_operating_summary_review_guide',
      {
        title: 'OP 经营摘要核对指南',
        description: '指导 AI 只读解释固定经营指标、修订和来源摘要，不执行写入或财务推断。',
        argsSchema: { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) },
      },
      ({ date }) => ({ messages: [{ role: 'user', content: {
        type: 'text',
        text: `请读取 ${date} 的 OP 经营摘要，解释 GMV、支付单量、退款额、退款单量、活跃客户数以及当前修订。仅将其视为管理展示数据；不得用于工资、税务、资金或会计计算，不得触发 OP 写入或补造数据。`,
      } }] }),
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
      'marketing_side_effect_get',
      {
        title: '查询营销副作用可靠性状态',
        description: '按当前租户返回通知或排期副作用的受控状态、尝试次数与错误码，不返回联系人或正文。风险等级 R1。',
        inputSchema: { eventId: marketingEventIdSchema },
        outputSchema: marketingSideEffectOutputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ eventId }, extra) => this.tools.getMarketingSideEffect(eventId, extra),
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
      'approval_timeline_get',
      {
        title: '查询审批时间线',
        description: '返回当前主体有权读取的追加式审批动作，不包含租户字段或表单正文。风险等级 R0。',
        inputSchema: { instanceId: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/) },
        outputSchema: approvalTimelineOutputSchema,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      async ({ instanceId }, extra) => this.tools.getApprovalTimeline(instanceId, extra),
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
      'onboarding_get',
      {
        title: '查询入职进度摘要',
        description: '返回任务状态、组织引用和建档状态，不返回任何证据原文。风险等级 R0。',
        inputSchema: { id: recruitmentIdSchema },
        outputSchema: z.object({ onboarding: onboardingSchema }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      async ({ id }, extra) => this.tools.getOnboarding(id, extra),
    );

    server.registerTool(
      'knowledge_course_get',
      {
        title: '查询课程版本脱敏摘要',
        description: '返回课程状态和考试配置，不返回内容、题库或答案。风险等级 R0。',
        inputSchema: { id: recruitmentIdSchema },
        outputSchema: z.object({ course: knowledgeCourseSchema }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      async ({ id }, extra) => this.tools.getKnowledgeCourse(id, extra),
    );

    server.registerTool(
      'knowledge_assignment_get',
      {
        title: '查询培训任务脱敏摘要',
        description: '返回进度、截止日期与状态，不返回答卷或证据引用。风险等级 R0。',
        inputSchema: { id: recruitmentIdSchema },
        outputSchema: z.object({ assignment: knowledgeAssignmentSchema }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      async ({ id }, extra) => this.tools.getKnowledgeAssignment(id, extra),
    );

    server.registerTool(
      'care_case_get',
      {
        title: '查询离职案件脱敏进度',
        description: '返回清算任务、最后工作日和状态，不返回原因或证据。风险等级 R0。',
        inputSchema: { id: recruitmentIdSchema },
        outputSchema: z.object({ careCase: careCaseSchema }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      async ({ id }, extra) => this.tools.getCareCase(id, extra),
    );

    server.registerTool(
      'attendance_month_get',
      {
        title: '查询本人考勤月结摘要',
        description: '由已验证主体反查 ERP 员工，只返回月度汇总和快照完整性标识。风险等级 R0。',
        inputSchema: { month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) },
        outputSchema: z.object({ attendanceMonth: attendanceMonthSchema }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      async ({ month }, extra) => this.tools.getMyAttendanceMonth(month, extra),
    );

    server.registerTool(
      'payroll_period_get',
      {
        title: '查询工资周期脱敏汇总',
        description: '只返回财务汇总和完整性摘要，不返回员工级输入、结果或证据正文。风险等级 R0。',
        inputSchema: { id: recruitmentIdSchema },
        outputSchema: z.object({ payrollPeriod: payrollPeriodSchema }),
        annotations: {
          readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
        },
      },
      async ({ id }, extra) => this.tools.getPayrollPeriod(id, extra),
    );

    server.registerTool(
      'payroll_payslip_get_self',
      {
        title: '查询本人已发布薪资单',
        description: '从已验证主体反查 ERP 员工，仅返回已锁定月份的本人 L4 薪资单。风险等级 R1。',
        inputSchema: { period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) },
        outputSchema: z.object({ payslip: payrollPayslipSchema }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ period }, extra) => this.tools.getMyPayrollPayslip(period, extra),
    );

    server.registerTool(
      'payroll_tax_filing_get',
      {
        title: '查询个税申报脱敏控制摘要',
        description: '只返回申报状态、控制总额、摘要和证据标识；不返回正文、人员身份或外部对象地址。风险等级 R1。',
        inputSchema: { id: recruitmentIdSchema },
        outputSchema: z.object({ taxFiling: payrollTaxFilingSchema }),
        annotations: {
          readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
        },
      },
      async ({ id }, extra) => this.tools.getPayrollTaxFiling(id, extra),
    );

    server.registerTool(
      'payroll_reconciliation_get',
      {
        title: '查询工资四方对账控制摘要',
        description: '返回工资、代发、回盘、个税控制量和标准差异码；不返回员工或外部正文。风险等级 R1。',
        inputSchema: { id: recruitmentIdSchema },
        outputSchema: z.object({ reconciliation: payrollReconciliationSchema }),
        annotations: {
          readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
        },
      },
      async ({ id }, extra) => this.tools.getPayrollReconciliation(id, extra),
    );

    server.registerTool(
      'payroll_shadow_cycle_get',
      {
        title: '查询工资影子周期脱敏摘要',
        description: '只返回新旧工资控制量、标准差异码、解释进度和签署状态。风险等级 R1。',
        inputSchema: { id: recruitmentIdSchema },
        outputSchema: z.object({ shadowCycle: payrollShadowCycleSchema }),
        annotations: {
          readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
        },
      },
      async ({ id }, extra) => this.tools.getPayrollShadowCycle(id, extra),
    );

    server.registerTool(
      'payroll_cutover_readiness_get',
      {
        title: '查询工资两期可切换资格证据',
        description: '只返回连续两期范围与证据摘要，不执行切换。风险等级 R1。',
        inputSchema: { id: recruitmentIdSchema },
        outputSchema: z.object({ cutoverReadiness: payrollCutoverReadinessSchema }),
        annotations: {
          readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
        },
      },
      async ({ id }, extra) => this.tools.getPayrollCutoverReadiness(id, extra),
    );

    server.registerTool(
      'op_operating_summary_get',
      {
        title: '查询 OP 每日经营摘要',
        description: '读取固定白名单经营指标与最新修订，仅供管理展示。风险等级 R0。',
        inputSchema: { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) },
        outputSchema: z.object({ operatingSummary: opOperatingSummarySchema }),
        annotations: {
          readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
        },
      },
      async ({ date }, extra) => this.tools.getOpOperatingSummary(date, extra),
    );

    server.registerTool(
      'op_approval_bridge_get',
      {
        title: '查询 OP 来源审批状态',
        description: '读取来源单据、ERP 审批实例、状态与版本，不返回表单正文。风险等级 R0。',
        inputSchema: {
          externalEventId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        },
        outputSchema: z.object({ approvalBridge: opApprovalBridgeSchema }),
        annotations: {
          readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
        },
      },
      async ({ externalEventId }, extra) =>
        this.tools.getOpApprovalBridge(externalEventId, extra),
    );

    server.registerTool(
      'management_dashboard_get',
      {
        title: '查询管理驾驶舱',
        description: '读取固定口径跨域聚合指标，不返回个人明细。风险等级 R1。',
        inputSchema: { asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) },
        outputSchema: z.object({ dashboard: managementDashboardSchema }),
        annotations: {
          readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
        },
      },
      async ({ asOf }, extra) => this.tools.getManagementDashboard(asOf, extra),
    );

    server.registerTool(
      'data_migration_report_get',
      {
        title: '查询数据迁移差异报告',
        description: '读取 Phase 6 预验收控制量和差异，不返回来源正文。风险等级 R1。',
        inputSchema: { runId: recruitmentIdSchema },
        outputSchema: z.object({ report: dataMigrationReportSchema }),
        annotations: {
          readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
        },
      },
      async ({ runId }, extra) => this.tools.getDataMigrationReport(runId, extra),
    );

    server.registerTool(
      'management_dashboard_export_prepare',
      {
        title: '准备管理驾驶舱导出',
        description: '固定口径 JSON 导出的 R2 准备操作；只生成确认单，不创建导出任务。',
        inputSchema: {
          asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          prepareKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
        },
        outputSchema: preparedOperationOutputSchema,
        annotations: {
          readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false,
        },
      },
      async ({ asOf, prepareKey }, extra) =>
        this.tools.prepareManagementDashboardExport(asOf, prepareKey, extra),
    );

    server.registerTool(
      'management_dashboard_export_execute',
      {
        title: '执行管理驾驶舱导出',
        description: '消费经 Passkey 强认证的一次性凭据并创建异步任务，返回可轮询资源链接。风险等级 R2。',
        inputSchema: confirmationExecuteInputSchema,
        outputSchema: z.object({ export: analyticsExportSchema }),
        annotations: {
          readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false,
        },
      },
      async ({ operationId, confirmationCredential }, extra) =>
        this.tools.executeManagementDashboardExport(operationId, confirmationCredential, extra),
    );

    server.registerTool(
      'attendance_correction_prepare',
      {
        title: '准备本人考勤修订申请',
        description: '校验本人源事实和受控分钟/原因码，生成 R1 服务端确认单；不会改事实或创建审批。',
        inputSchema: {
          ...attendanceCorrectionInputSchema,
          prepareKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
        },
        outputSchema: preparedOperationOutputSchema,
        annotations: {
          readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false,
        },
      },
      async (input, extra) => this.tools.prepareAttendanceCorrectionRequest(input, extra),
    );

    server.registerTool(
      'attendance_correction_execute',
      {
        title: '提交本人考勤修订审批',
        description: '仅消费 ERP 用户确认后的固化命令，创建并提交 attendance_correction 审批；不修改源事实。风险等级 R1。',
        inputSchema: confirmationExecuteInputSchema,
        outputSchema: z.object({ request: attendanceCorrectionRequestSchema }),
        annotations: {
          readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false,
        },
      },
      async ({ operationId, confirmationCredential }, extra) =>
        this.tools.executeAttendanceCorrectionRequest(
          operationId, confirmationCredential, extra,
        ),
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

function requiredMarketingEventId(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value)) {
    throw new Error('MCP_MARKETING_EVENT_ID_INVALID');
  }
  return value;
}

function requiredMonth(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new Error('MCP_ATTENDANCE_MONTH_INVALID');
  }
  return value;
}

function requiredDate(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('MCP_OP_SUMMARY_DATE_INVALID');
  }
  return value;
}

function requiredExternalEventId(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
    throw new Error('MCP_OP_APPROVAL_EVENT_ID_INVALID');
  }
  return value;
}
