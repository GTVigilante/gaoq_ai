import { ULID_PATTERN } from '@gaoq/shared-utils';
import { z } from 'zod';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export const ANALYTICS_DASHBOARD_SOURCES = Object.freeze([
  'org_employees',
  'approval_instances',
  'approval_actions',
  'recruitment_positions',
  'recruitment_applications',
  'knowledge_training_assignments',
  'payroll_periods',
  'op_operating_summaries',
] as const);

export const managementDashboardSchema = z.object({
  asOf: z.string().regex(DATE),
  window: z.object({
    from: z.string().regex(DATE),
    to: z.string().regex(DATE),
    timezone: z.literal('Asia/Shanghai'),
  }).strict(),
  generatedAt: z.string().datetime(),
  freshness: z.object({
    transactional: z.literal('live'),
    operatingSummaryDate: z.string().regex(DATE).nullable(),
    payrollPeriod: z.string().regex(MONTH).nullable(),
  }).strict(),
  workforce: z.object({
    activeHeadcount: z.number().int().nonnegative(),
    probationHeadcount: z.number().int().nonnegative(),
    suspendedHeadcount: z.number().int().nonnegative(),
  }).strict(),
  approvals: z.object({
    running: z.number().int().nonnegative(),
    overdue48h: z.number().int().nonnegative(),
    completed30d: z.number().int().nonnegative(),
    approvalRateBps: z.number().int().min(0).max(10_000).nullable(),
  }).strict(),
  recruitment: z.object({
    openPositionCount: z.number().int().nonnegative(),
    openHeadcount: z.number().int().nonnegative(),
    activeApplicationCount: z.number().int().nonnegative(),
    hired30d: z.number().int().nonnegative(),
  }).strict(),
  learning: z.object({
    mandatoryAssignments: z.number().int().nonnegative(),
    completedMandatoryAssignments: z.number().int().nonnegative(),
    expiredMandatoryAssignments: z.number().int().nonnegative(),
    completionRateBps: z.number().int().min(0).max(10_000).nullable(),
  }).strict(),
  payroll: z.object({
    period: z.string().regex(MONTH).nullable(),
    status: z.enum([
      'draft', 'collecting', 'review', 'pending_approval', 'approved',
      'locked', 'disbursing', 'reconciling', 'reconciled',
    ]).nullable(),
    employeeCount: z.number().int().nonnegative().nullable(),
  }).strict(),
  operating: z.object({
    summaryDate: z.string().regex(DATE).nullable(),
    revision: z.number().int().positive().nullable(),
    currency: z.literal('CNY').nullable(),
    gmvMinor: z.number().int().nonnegative().nullable(),
    paidOrderCount: z.number().int().nonnegative().nullable(),
    refundMinor: z.number().int().nonnegative().nullable(),
  }).strict(),
  sources: z.tuple([
    z.literal('org_employees'),
    z.literal('approval_instances'),
    z.literal('approval_actions'),
    z.literal('recruitment_positions'),
    z.literal('recruitment_applications'),
    z.literal('knowledge_training_assignments'),
    z.literal('payroll_periods'),
    z.literal('op_operating_summaries'),
  ]),
}).strict();

export type ManagementDashboardView = z.infer<typeof managementDashboardSchema>;

export const analyticsExportArtifactSchema = z.object({
  schemaVersion: z.literal('management-dashboard-export.v1'),
  exportedAt: z.string().datetime(),
  dashboard: managementDashboardSchema,
}).strict();

export type AnalyticsExportArtifact = z.infer<typeof analyticsExportArtifactSchema>;

export const analyticsExportViewSchema = z.object({
  id: z.string().regex(ULID_PATTERN),
  asOf: z.string().regex(DATE),
  format: z.literal('json'),
  status: z.enum(['queued', 'processing', 'ready', 'failed']),
  resourceUri: z.string().regex(/^erp:\/\/analytics\/exports\/[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
  contentHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/).nullable(),
  artifact: analyticsExportArtifactSchema.nullable(),
  expiresAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
  if (value.resourceUri !== `erp://analytics/exports/${value.id}`) {
    context.addIssue({ code: 'custom', message: '导出资源 URI 与导出标识不一致' });
  }
  if (value.status === 'ready' && (value.contentHash === null || value.artifact === null)) {
    context.addIssue({ code: 'custom', message: '就绪导出缺少产物或内容摘要' });
  }
  if (value.status !== 'ready' && (value.contentHash !== null || value.artifact !== null)) {
    context.addIssue({ code: 'custom', message: '未就绪导出不得返回产物或内容摘要' });
  }
  if (value.artifact !== null && value.artifact.dashboard.asOf !== value.asOf) {
    context.addIssue({ code: 'custom', message: '导出产物口径日与导出记录不一致' });
  }
});

export type AnalyticsExportView = z.infer<typeof analyticsExportViewSchema>;
