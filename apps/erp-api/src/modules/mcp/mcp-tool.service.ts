import { Injectable } from '@nestjs/common';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';

import { AuditService } from '../../core/audit/audit.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import { OrgApplicationService } from '../org/application/org-application.service.js';
import { ApprovalApplicationService } from '../approval/application/approval-application.service.js';
import { RecruitmentApplicationService } from '../recruitment/application/recruitment-application.service.js';
import { RecruitmentInterviewService } from '../recruitment/application/recruitment-interview.service.js';
import { RecruitmentManagementService } from '../recruitment/application/recruitment-management.service.js';
import { RecruitmentOfferService } from '../recruitment/application/recruitment-offer.service.js';
import { OnboardingApplicationService } from '../onboarding/application/onboarding-application.service.js';
import { KnowledgeApplicationService } from '../knowledge/application/knowledge-application.service.js';
import { CareApplicationService } from '../care/application/care-application.service.js';
import { AttendanceApplicationService } from '../attendance/application/attendance-application.service.js';
import { PayrollRunService } from '../payroll/application/payroll-run.service.js';
import { PayrollPayslipService } from '../payroll/application/payroll-payslip.service.js';
import { PayrollTaxFilingService } from '../payroll/application/payroll-tax-filing.service.js';
import { PayrollReconciliationService } from '../payroll/application/payroll-reconciliation.service.js';
import { PayrollShadowService } from '../payroll/application/payroll-shadow.service.js';
import { OpOperatingSummaryService } from '../op/application/op-operating-summary.service.js';
import { OpApprovalBridgeService } from '../op/application/op-approval-bridge.service.js';
import { ManagementDashboardService } from '../analytics/application/management-dashboard.service.js';
import { AnalyticsExportService } from '../analytics/application/analytics-export.service.js';
import { DataMigrationService } from '../data-migration/application/data-migration.service.js';
import { TalentLifecycleService } from '../talent-lifecycle/application/talent-lifecycle.service.js';
import { parseMcpIdentity, type McpIdentity } from './mcp-auth-context.js';
import {
  McpConfirmationService,
  type McpCommand,
  type McpPreparedOperation,
} from './mcp-confirmation.service.js';

type ApprovalMcpCommand = Extract<McpCommand, {
  readonly operation: 'approval.submit' | 'approval.withdraw' | 'approval.decide';
}>;
type AttendanceMcpCommand = Extract<McpCommand, {
  readonly operation: 'attendance.correction.request';
}>;
type AnalyticsMcpCommand = Extract<McpCommand, {
  readonly operation: 'analytics.management_dashboard.export';
}>;
type RecruitmentMcpCommand = Exclude<
  McpCommand,
  ApprovalMcpCommand | AttendanceMcpCommand | AnalyticsMcpCommand
>;
type ApprovalMcpOperation = ApprovalMcpCommand['operation'];
type RecruitmentMcpOperation = RecruitmentMcpCommand['operation'];

export type McpToolResult = CallToolResult;

type McpExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** MCP 工具应用层；只复用业务应用服务，不直接访问数据库或上游 Token。 */
@Injectable()
export class McpToolService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
    private readonly organization: OrgApplicationService,
    private readonly approvals: ApprovalApplicationService,
    private readonly recruitmentApplications: RecruitmentApplicationService,
    private readonly recruitmentInterviews: RecruitmentInterviewService,
    private readonly recruitmentManagement: RecruitmentManagementService,
    private readonly recruitmentOffers: RecruitmentOfferService,
    private readonly onboarding: OnboardingApplicationService,
    private readonly knowledge: KnowledgeApplicationService,
    private readonly care: CareApplicationService,
    private readonly attendance: AttendanceApplicationService,
    private readonly payroll: PayrollRunService,
    private readonly payslips: PayrollPayslipService,
    private readonly taxFilings: PayrollTaxFilingService,
    private readonly reconciliations: PayrollReconciliationService,
    private readonly shadows: PayrollShadowService,
    private readonly opSummaries: OpOperatingSummaryService,
    private readonly opApprovalBridges: OpApprovalBridgeService,
    private readonly managementDashboard: ManagementDashboardService,
    private readonly analyticsExports: AnalyticsExportService,
    private readonly dataMigrations: DataMigrationService,
    private readonly talentLifecycle: TalentLifecycleService,
    private readonly confirmations: McpConfirmationService,
  ) {}

  async getRecruitmentApplication(id: string, extra: McpExtra): Promise<McpToolResult> {
    return this.getRecruitmentResource(
      extra, 'recruitment_application_get', 'erp:recruitment:application:read',
      'application', () => this.recruitmentApplications.getApplication(id),
    );
  }

  async getRecruitmentRequisition(id: string, extra: McpExtra): Promise<McpToolResult> {
    return this.getRecruitmentResource(
      extra, 'recruitment_requisition_get', 'erp:recruitment:management:read',
      'requisition', () => this.recruitmentManagement.getRequisition(id),
    );
  }

  async getRecruitmentPosition(id: string, extra: McpExtra): Promise<McpToolResult> {
    return this.getRecruitmentResource(
      extra, 'recruitment_position_get', 'erp:recruitment:management:read',
      'position', () => this.recruitmentManagement.getPosition(id),
    );
  }

  async getRecruitmentInterview(id: string, extra: McpExtra): Promise<McpToolResult> {
    return this.getRecruitmentResource(
      extra, 'recruitment_interview_get', 'erp:recruitment:interview:read',
      'interview', () => this.recruitmentInterviews.get(id),
    );
  }

  async getRecruitmentOffer(id: string, extra: McpExtra): Promise<McpToolResult> {
    return this.getRecruitmentResource(
      extra, 'recruitment_offer_get', 'erp:recruitment:offer:read',
      'offer', () => this.recruitmentOffers.get(id),
    );
  }

  async getOnboarding(id: string, extra: McpExtra): Promise<McpToolResult> {
    return this.getRecruitmentResource(
      extra, 'onboarding_get', 'erp:onboarding:read',
      'onboarding', () => this.onboarding.get(id),
    );
  }

  async getKnowledgeCourse(id: string, extra: McpExtra): Promise<McpToolResult> {
    return this.getRecruitmentResource(
      extra, 'knowledge_course_get', 'erp:knowledge:course:read',
      'course', () => this.knowledge.getCourse(id),
    );
  }

  async getKnowledgeAssignment(id: string, extra: McpExtra): Promise<McpToolResult> {
    return this.getRecruitmentResource(
      extra, 'knowledge_assignment_get', 'erp:knowledge:assignment:read',
      'assignment', () => this.knowledge.getAssignment(id),
    );
  }

  async getCareCase(id: string, extra: McpExtra): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    return this.run(identity, async () => {
      const required = ['erp:care:case:read', 'erp:care:employment:read'];
      const missing = required.find((scope) => !identity.scopes.includes(scope));
      if (missing !== undefined) {
        await this.auditTool(identity, 'care_case_get', 'R0', 'denied');
        return scopeError(missing);
      }
      const careCase = await this.care.getForMcp(id);
      await this.auditTool(identity, 'care_case_get', 'R0', 'success');
      return structuredResult({ careCase });
    });
  }

  async getTalentLifecycle(candidateId: string, extra: McpExtra): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    return this.run(identity, async () => {
      if (!identity.scopes.includes('erp:talent-lifecycle:read')) {
        await this.auditTool(identity, 'talent_lifecycle_get', 'R0', 'denied');
        return scopeError('erp:talent-lifecycle:read');
      }
      const lifecycle = await this.talentLifecycle.getForMcp(candidateId);
      await this.auditTool(identity, 'talent_lifecycle_get', 'R0', 'success');
      return structuredResult({ lifecycle });
    });
  }

  async getMyAttendanceMonth(month: string, extra: McpExtra): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    return this.run(identity, async () => {
      if (!identity.scopes.includes('erp:attendance:month:read_self')) {
        await this.auditTool(identity, 'attendance_month_get', 'R0', 'denied');
        return scopeError('erp:attendance:month:read_self');
      }
      const attendanceMonth = await this.attendance.getMyMonth(month);
      await this.auditTool(identity, 'attendance_month_get', 'R0', 'success');
      return structuredResult({ attendanceMonth });
    });
  }

  async getPayrollPeriod(id: string, extra: McpExtra): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    return this.run(identity, async () => {
      if (!identity.scopes.includes('erp:payroll:period:read')) {
        await this.auditTool(identity, 'payroll_period_get', 'R0', 'denied');
        return scopeError('erp:payroll:period:read');
      }
      const payrollPeriod = await this.payroll.getPeriod(id);
      await this.auditTool(identity, 'payroll_period_get', 'R0', 'success');
      return structuredResult({ payrollPeriod });
    });
  }

  async getMyPayrollPayslip(period: string, extra: McpExtra): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    return this.run(identity, async () => {
      if (!identity.scopes.includes('erp:payroll:sheet:read_self')) {
        await this.auditTool(identity, 'payroll_payslip_get_self', 'R1', 'denied');
        return scopeError('erp:payroll:sheet:read_self');
      }
      const payslip = await this.payslips.getMyPayslip(period);
      await this.auditTool(identity, 'payroll_payslip_get_self', 'R1', 'success', {
        period, inputHash: payslip.inputHash, resultHash: payslip.resultHash,
      });
      return structuredResult({ payslip });
    });
  }

  async getPayrollTaxFiling(id: string, extra: McpExtra): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    return this.run(identity, async () => {
      if (!identity.scopes.includes('erp:payroll:tax:read')) {
        await this.auditTool(identity, 'payroll_tax_filing_get', 'R1', 'denied');
        return scopeError('erp:payroll:tax:read');
      }
      const taxFiling = await this.taxFilings.getStatus(id);
      await this.auditTool(identity, 'payroll_tax_filing_get', 'R1', 'success', {
        filingId: taxFiling.id, status: taxFiling.status,
        contentHash: taxFiling.contentHash,
      });
      return structuredResult({ taxFiling });
    });
  }

  async getPayrollReconciliation(id: string, extra: McpExtra): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    return this.run(identity, async () => {
      if (!identity.scopes.includes('erp:payroll:reconciliation:read')) {
        await this.auditTool(identity, 'payroll_reconciliation_get', 'R1', 'denied');
        return scopeError('erp:payroll:reconciliation:read');
      }
      const reconciliation = await this.reconciliations.getStatus(id);
      await this.auditTool(identity, 'payroll_reconciliation_get', 'R1', 'success', {
        reconciliationId: reconciliation.id, status: reconciliation.status,
        evidenceHash: reconciliation.evidenceHash,
        differenceCount: reconciliation.differences.length,
      });
      return structuredResult({ reconciliation });
    });
  }

  async getPayrollShadowCycle(id: string, extra: McpExtra): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    return this.run(identity, async () => {
      if (!identity.scopes.includes('erp:payroll:shadow:read')) {
        await this.auditTool(identity, 'payroll_shadow_cycle_get', 'R1', 'denied');
        return scopeError('erp:payroll:shadow:read');
      }
      const shadowCycle = await this.shadows.getCycle(id);
      await this.auditTool(identity, 'payroll_shadow_cycle_get', 'R1', 'success', {
        cycleId: shadowCycle.id, period: shadowCycle.period, status: shadowCycle.status,
        comparisonHash: shadowCycle.comparisonHash,
        unresolvedDifferenceCount: shadowCycle.unresolvedDifferenceCount,
      });
      return structuredResult({ shadowCycle });
    });
  }

  async getPayrollCutoverReadiness(id: string, extra: McpExtra): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    return this.run(identity, async () => {
      if (!identity.scopes.includes('erp:payroll:shadow:read')) {
        await this.auditTool(identity, 'payroll_cutover_readiness_get', 'R1', 'denied');
        return scopeError('erp:payroll:shadow:read');
      }
      const cutoverReadiness = await this.shadows.getReadiness(id);
      await this.auditTool(identity, 'payroll_cutover_readiness_get', 'R1', 'success', {
        readinessId: cutoverReadiness.id, startPeriod: cutoverReadiness.startPeriod,
        endPeriod: cutoverReadiness.endPeriod, evidenceHash: cutoverReadiness.evidenceHash,
      });
      return structuredResult({ cutoverReadiness });
    });
  }

  async getOpOperatingSummary(date: string, extra: McpExtra): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    return this.run(identity, async () => {
      if (!identity.scopes.includes('erp:op:operating_summary:read')) {
        await this.auditTool(identity, 'op_operating_summary_get', 'R0', 'denied');
        return scopeError('erp:op:operating_summary:read');
      }
      const operatingSummary = await this.opSummaries.getLatest(date);
      await this.auditTool(identity, 'op_operating_summary_get', 'R0', 'success', {
        summaryDate: operatingSummary.summaryDate, revision: operatingSummary.revision,
        payloadHash: operatingSummary.payloadHash,
      });
      return structuredResult({ operatingSummary });
    });
  }

  async getOpApprovalBridge(externalEventId: string, extra: McpExtra): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    return this.run(identity, async () => {
      if (!identity.scopes.includes('erp:op:approval_bridge:read')) {
        await this.auditTool(identity, 'op_approval_bridge_get', 'R0', 'denied');
        return scopeError('erp:op:approval_bridge:read');
      }
      const approvalBridge = await this.opApprovalBridges.get(externalEventId);
      await this.auditTool(identity, 'op_approval_bridge_get', 'R0', 'success', {
        externalEventId: approvalBridge.externalEventId,
        approvalStatus: approvalBridge.approvalStatus,
        approvalVersion: approvalBridge.approvalVersion,
      });
      return structuredResult({ approvalBridge });
    });
  }

  async getManagementDashboard(asOf: string, extra: McpExtra): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    return this.run(identity, async () => {
      if (!identity.scopes.includes('erp:analytics:management:read')) {
        await this.auditTool(identity, 'management_dashboard_get', 'R1', 'denied');
        return scopeError('erp:analytics:management:read');
      }
      const dashboard = await this.managementDashboard.get(asOf);
      await this.auditTool(identity, 'management_dashboard_get', 'R1', 'success', {
        asOf: dashboard.asOf, sourceCount: dashboard.sources.length,
      });
      return structuredResult({ dashboard });
    });
  }

  async getAnalyticsExport(exportId: string, extra: McpExtra): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    return this.run(identity, async () => {
      if (!identity.scopes.includes('erp:analytics:management:export')) {
        await this.auditTool(identity, 'management_dashboard_export_get', 'R1', 'denied');
        return scopeError('erp:analytics:management:export');
      }
      const result = await this.analyticsExports.get(exportId);
      await this.auditTool(identity, 'management_dashboard_export_get', 'R1', 'success', {
        exportId, status: result.status,
      });
      return structuredResult({ export: result });
    });
  }

  async getDataMigrationReport(runId: string, extra: McpExtra): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    return this.run(identity, async () => {
      if (!identity.scopes.includes('erp:migration:read')) {
        await this.auditTool(identity, 'data_migration_report_get', 'R1', 'denied');
        return scopeError('erp:migration:read');
      }
      const report = await this.dataMigrations.report(runId);
      await this.auditTool(identity, 'data_migration_report_get', 'R1', 'success', {
        runId, status: report.status, differenceCount: report.differences.length,
        phaseSixEligible: report.phaseSixEligible,
      });
      return structuredResult({ report });
    });
  }

  async prepareManagementDashboardExport(
    asOf: string,
    prepareKey: string,
    extra: McpExtra,
  ): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    return this.run(identity, async () => {
      const missing = ['erp:analytics:management:read', 'erp:analytics:management:export']
        .find((scope) => !identity.scopes.includes(scope));
      if (missing !== undefined) {
        await this.auditTool(identity, 'management_dashboard_export_prepare', 'R2', 'denied');
        return scopeError(missing);
      }
      await this.managementDashboard.get(asOf);
      const command: AnalyticsMcpCommand = {
        operation: 'analytics.management_dashboard.export', asOf,
        format: 'json', expectedVersion: 1,
      };
      const prepared = await this.confirmations.prepare(identity, prepareKey, command, 'R2');
      await this.auditTool(identity, 'management_dashboard_export_prepare', 'R2', 'success', {
        operationId: prepared.operationId, digest: prepared.digest, asOf,
      });
      return preparedResult(prepared);
    });
  }

  async executeManagementDashboardExport(
    operationId: string,
    confirmationCredential: string,
    extra: McpExtra,
  ): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    return this.run(identity, async () => {
      const missing = ['erp:analytics:management:read', 'erp:analytics:management:export']
        .find((scope) => !identity.scopes.includes(scope));
      if (missing !== undefined) {
        await this.auditTool(identity, 'management_dashboard_export_execute', 'R2', 'denied');
        return scopeError(missing);
      }
      const claimed = await this.confirmations.claim(
        identity, 'analytics.management_dashboard.export', operationId, confirmationCredential,
      );
      if (claimed.replayResult !== null) {
        await this.auditTool(identity, 'management_dashboard_export_execute', 'R2', 'success', {
          operationId, replayed: true,
        });
        return exportResourceResult(claimed.replayResult);
      }
      try {
        if (!isAnalyticsCommand(claimed.command)) {
          throw new Error('MCP_ANALYTICS_COMMAND_TYPE_MISMATCH');
        }
        const exportView = await this.analyticsExports.request(operationId, claimed.command.asOf);
        const result: Record<string, unknown> = { export: exportView };
        await this.confirmations.complete(operationId, result);
        await this.auditTool(identity, 'management_dashboard_export_execute', 'R2', 'success', {
          operationId, replayed: false, asOf: claimed.command.asOf,
        });
        return exportResourceResult(result);
      } catch (error) {
        await this.confirmations.release(operationId);
        await this.auditTool(identity, 'management_dashboard_export_execute', 'R2', 'failure', {
          operationId,
        });
        throw error;
      }
    });
  }

  async prepareAttendanceCorrectionRequest(
    input: {
      readonly sourceFactId: string;
      readonly workedMinutes: number;
      readonly leaveMinutes: number;
      readonly overtimeMinutes: number;
      readonly absentMinutes: number;
      readonly reasonCode: string;
      readonly prepareKey: string;
    },
    extra: McpExtra,
  ): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    return this.run(identity, async () => {
      const required = [
        'erp:attendance:correction:request', 'erp:approval:instance:submit',
      ];
      const missing = required.find((scope) => !identity.scopes.includes(scope));
      if (missing !== undefined) {
        await this.auditTool(identity, 'attendance_correction_prepare', 'R1', 'denied');
        return scopeError(missing);
      }
      await this.attendance.validateCorrectionRequest({
        sourceFactId: input.sourceFactId,
        replacementImpact: {
          workedMinutes: input.workedMinutes, leaveMinutes: input.leaveMinutes,
          overtimeMinutes: input.overtimeMinutes, absentMinutes: input.absentMinutes,
        },
        reasonCode: input.reasonCode,
      });
      const command: AttendanceMcpCommand = {
        operation: 'attendance.correction.request', sourceFactId: input.sourceFactId,
        expectedVersion: 1, workedMinutes: input.workedMinutes,
        leaveMinutes: input.leaveMinutes, overtimeMinutes: input.overtimeMinutes,
        absentMinutes: input.absentMinutes, reasonCode: input.reasonCode,
      };
      const prepared = await this.confirmations.prepare(identity, input.prepareKey, command, 'R1');
      await this.auditTool(identity, 'attendance_correction_prepare', 'R1', 'success', {
        operationId: prepared.operationId, digest: prepared.digest,
      });
      return preparedResult(prepared);
    });
  }

  async executeAttendanceCorrectionRequest(
    operationId: string,
    confirmationCredential: string,
    extra: McpExtra,
  ): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    return this.run(identity, async () => {
      const required = [
        'erp:attendance:correction:request', 'erp:approval:instance:submit',
      ];
      const missing = required.find((scope) => !identity.scopes.includes(scope));
      if (missing !== undefined) {
        await this.auditTool(identity, 'attendance_correction_execute', 'R1', 'denied');
        return scopeError(missing);
      }
      const claimed = await this.confirmations.claim(
        identity, 'attendance.correction.request', operationId, confirmationCredential,
      );
      if (claimed.replayResult !== null) {
        await this.auditTool(identity, 'attendance_correction_execute', 'R1', 'success', {
          operationId, replayed: true,
        });
        return structuredResult(claimed.replayResult);
      }
      try {
        if (!isAttendanceCommand(claimed.command)) {
          throw new Error('MCP_ATTENDANCE_COMMAND_TYPE_MISMATCH');
        }
        const result = await this.attendance.requestCorrection(`mcp:${operationId}`, {
          sourceFactId: claimed.command.sourceFactId,
          replacementImpact: {
            workedMinutes: claimed.command.workedMinutes,
            leaveMinutes: claimed.command.leaveMinutes,
            overtimeMinutes: claimed.command.overtimeMinutes,
            absentMinutes: claimed.command.absentMinutes,
          },
          reasonCode: claimed.command.reasonCode,
        });
        await this.confirmations.complete(operationId, result);
        await this.auditTool(identity, 'attendance_correction_execute', 'R1', 'success', {
          operationId, replayed: false,
        });
        return structuredResult(result);
      } catch (error) {
        await this.confirmations.release(operationId);
        await this.auditTool(identity, 'attendance_correction_execute', 'R1', 'failure', {
          operationId,
        });
        throw error;
      }
    });
  }

  async prepareRecruitmentRequisitionSubmit(
    requisitionId: string,
    expectedVersion: number,
    prepareKey: string,
    extra: McpExtra,
  ): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    return this.run(identity, async () => {
      const missing = [
        'erp:recruitment:management:read', 'erp:recruitment:requisition:submit',
      ].find((scope) => !identity.scopes.includes(scope));
      if (missing !== undefined) return this.deniedRecruitmentPrepare(
        identity, 'recruitment_requisition_submit_prepare', 'R2', missing,
      );
      const resource = await this.recruitmentManagement.getRequisition(requisitionId);
      if (resource.version !== expectedVersion || resource.status !== 'draft') return this.changed(
        identity, 'recruitment_requisition_submit_prepare', 'R2', 'HC 状态或版本已变化',
      );
      return this.prepareRecruitmentCommand(identity, prepareKey, {
        operation: 'recruitment.requisition.submit', requisitionId, expectedVersion,
      }, 'R2', 'recruitment_requisition_submit_prepare');
    });
  }

  async prepareRecruitmentPositionTransition(
    input: {
      readonly positionId: string;
      readonly expectedVersion: number;
      readonly targetStatus: 'open' | 'paused' | 'closed';
      readonly prepareKey: string;
    },
    extra: McpExtra,
  ): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    return this.run(identity, async () => {
      const missing = [
        'erp:recruitment:management:read', 'erp:recruitment:position:transition',
      ].find((scope) => !identity.scopes.includes(scope));
      if (missing !== undefined) return this.deniedRecruitmentPrepare(
        identity, 'recruitment_position_transition_prepare', 'R1', missing,
      );
      const resource = await this.recruitmentManagement.getPosition(input.positionId);
      const allowed: Readonly<Record<typeof resource.status, readonly string[]>> = {
        draft: ['open'], open: ['paused', 'closed'], paused: ['open', 'closed'], closed: [],
      };
      if (
        resource.version !== input.expectedVersion ||
        !allowed[resource.status].includes(input.targetStatus)
      ) {
        return this.changed(
          identity, 'recruitment_position_transition_prepare', 'R1', '职位状态或版本已变化',
        );
      }
      return this.prepareRecruitmentCommand(identity, input.prepareKey, {
        operation: 'recruitment.position.transition', positionId: input.positionId,
        expectedVersion: input.expectedVersion, targetStatus: input.targetStatus,
      }, 'R1', 'recruitment_position_transition_prepare');
    });
  }

  async prepareRecruitmentOfferSend(
    offerId: string,
    expectedVersion: number,
    prepareKey: string,
    extra: McpExtra,
  ): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    return this.run(identity, async () => {
      const missing = ['erp:recruitment:offer:read', 'erp:recruitment:offer:send']
        .find((scope) => !identity.scopes.includes(scope));
      if (missing !== undefined) return this.deniedRecruitmentPrepare(
        identity, 'recruitment_offer_send_prepare', 'R2', missing,
      );
      const resource = await this.recruitmentOffers.get(offerId);
      if (resource.version !== expectedVersion || resource.status !== 'approved') return this.changed(
        identity, 'recruitment_offer_send_prepare', 'R2', 'Offer 状态或版本已变化',
      );
      return this.prepareRecruitmentCommand(identity, prepareKey, {
        operation: 'recruitment.offer.request_send', offerId, expectedVersion,
      }, 'R2', 'recruitment_offer_send_prepare');
    });
  }

  async executeRecruitmentRequisitionSubmit(
    operationId: string,
    confirmationCredential: string,
    extra: McpExtra,
  ): Promise<McpToolResult> {
    return this.executeRecruitmentOperation(
      extra, 'recruitment.requisition.submit',
      ['erp:recruitment:requisition:submit'], operationId, confirmationCredential,
    );
  }

  async executeRecruitmentPositionTransition(
    operationId: string,
    confirmationCredential: string,
    extra: McpExtra,
  ): Promise<McpToolResult> {
    return this.executeRecruitmentOperation(
      extra, 'recruitment.position.transition',
      ['erp:recruitment:position:transition'], operationId, confirmationCredential,
    );
  }

  async executeRecruitmentOfferSend(
    operationId: string,
    confirmationCredential: string,
    extra: McpExtra,
  ): Promise<McpToolResult> {
    return this.executeRecruitmentOperation(
      extra, 'recruitment.offer.request_send',
      ['erp:recruitment:offer:send'], operationId, confirmationCredential,
    );
  }

  async getMyPermissions(extra: McpExtra): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    return this.run(identity, async () => {
      const data = {
        actorId: identity.actorId,
        roleCodes: identity.roleCodes,
        scopes: identity.scopes,
        departmentIds: identity.departmentIds,
      };
      await this.audit.record({
        action: 'mcp.tool.get_my_permissions',
        resourceType: 'mcp_tool',
        resourceId: 'get_my_permissions',
        riskLevel: 'R0',
        outcome: 'success',
        metadata: { clientId: identity.clientId, protocol: '2025-11-25' },
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(data) }],
        structuredContent: data,
      };
    });
  }

  async getOrgChart(extra: McpExtra): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    return this.run(identity, async () => {
      if (!identity.scopes.includes('erp:org:chart:read')) {
        await this.audit.record({
          action: 'mcp.tool.get_org_chart',
          resourceType: 'mcp_tool',
          resourceId: 'get_org_chart',
          riskLevel: 'R0',
          outcome: 'denied',
          metadata: { clientId: identity.clientId, protocol: '2025-11-25' },
        });
        return {
          isError: true,
          content: [{
            type: 'text',
            text: JSON.stringify({ code: 'AUTH_INSUFFICIENT_SCOPE', message: '需要 erp:org:chart:read' }),
          }],
        };
      }
      const chart = await this.organization.getOrgChart();
      const data: Record<string, unknown> = {
        departments: chart.departments,
        employees: chart.employees,
      };
      await this.audit.record({
        action: 'mcp.tool.get_org_chart',
        resourceType: 'mcp_tool',
        resourceId: 'get_org_chart',
        riskLevel: 'R0',
        outcome: 'success',
        metadata: {
          clientId: identity.clientId,
          protocol: '2025-11-25',
          departmentCount: chart.departments.length,
          employeeCount: chart.employees.length,
        },
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(data) }],
        structuredContent: data,
      };
    });
  }

  async getApprovalInbox(extra: McpExtra): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    return this.run(identity, async () => {
      if (!identity.scopes.includes('erp:approval:instance:read')) {
        await this.auditTool(identity, 'approval_get_inbox', 'R0', 'denied');
        return scopeError('erp:approval:instance:read');
      }
      const items = await this.approvals.getInbox();
      const data: Record<string, unknown> = { items };
      await this.auditTool(identity, 'approval_get_inbox', 'R0', 'success', { count: items.length });
      return {
        content: [{ type: 'text', text: JSON.stringify(data) }],
        structuredContent: data,
      };
    });
  }

  /** MCP Resource 使用的已发布模板表单目录；不注册为 Tool，避免能力目录重复。 */
  async getApprovalTemplateCatalog(extra: McpExtra): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    return this.run(identity, async () => {
      if (!identity.scopes.includes('erp:approval:instance:submit')) {
        await this.auditTool(identity, 'approval_template_catalog', 'R0', 'denied');
        return scopeError('erp:approval:instance:submit');
      }
      const templates = await this.approvals.listPublishedTemplateForms();
      const data: Record<string, unknown> = { templates };
      await this.auditTool(identity, 'approval_template_catalog', 'R0', 'success', { count: templates.length });
      return {
        content: [{ type: 'text', text: JSON.stringify(data) }],
        structuredContent: data,
      };
    });
  }

  /** MCP 只读委托目录；授权关系写入不注册 AI Tool。 */
  async getApprovalDelegations(extra: McpExtra): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    return this.run(identity, async () => {
      if (!identity.scopes.includes('erp:approval:delegation:read')) {
        await this.auditTool(identity, 'approval_delegations', 'R0', 'denied');
        return scopeError('erp:approval:delegation:read');
      }
      const delegations = await this.approvals.listMyDelegations();
      const data: Record<string, unknown> = { delegations };
      await this.auditTool(identity, 'approval_delegations', 'R0', 'success', {
        count: delegations.length,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(data) }],
        structuredContent: data,
      };
    });
  }

  async getApprovalInstance(instanceId: string, extra: McpExtra): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    return this.run(identity, async () => {
      if (!identity.scopes.includes('erp:approval:instance:read')) {
        await this.auditTool(identity, 'approval_get', 'R0', 'denied');
        return scopeError('erp:approval:instance:read');
      }
      const instance = await this.approvals.getInstance(instanceId);
      const data: Record<string, unknown> = { instance };
      await this.auditTool(identity, 'approval_get', 'R0', 'success');
      return {
        content: [{ type: 'text', text: JSON.stringify(data) }],
        structuredContent: data,
      };
    });
  }

  async getApprovalTimeline(instanceId: string, extra: McpExtra): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    return this.run(identity, async () => {
      if (!identity.scopes.includes('erp:approval:instance:read')) {
        await this.auditTool(identity, 'approval_timeline_get', 'R0', 'denied');
        return scopeError('erp:approval:instance:read');
      }
      const timeline = await this.approvals.getTimeline(instanceId);
      const data: Record<string, unknown> = { timeline };
      await this.auditTool(identity, 'approval_timeline_get', 'R0', 'success', { count: timeline.length });
      return {
        content: [{ type: 'text', text: JSON.stringify(data) }],
        structuredContent: data,
      };
    });
  }

  async prepareApprovalSubmit(
    instanceId: string,
    expectedVersion: number,
    prepareKey: string,
    extra: McpExtra,
  ): Promise<McpToolResult> {
    return this.prepareApprovalOperation(
      extra,
      ['erp:approval:instance:read', 'erp:approval:instance:submit'],
      { operation: 'approval.submit', instanceId, expectedVersion },
      prepareKey,
      'R1',
      ['draft'],
    );
  }

  async prepareApprovalWithdraw(
    instanceId: string,
    expectedVersion: number,
    prepareKey: string,
    extra: McpExtra,
  ): Promise<McpToolResult> {
    return this.prepareApprovalOperation(
      extra,
      ['erp:approval:instance:read', 'erp:approval:instance:submit'],
      { operation: 'approval.withdraw', instanceId, expectedVersion },
      prepareKey,
      'R1',
      ['draft', 'running'],
    );
  }

  async prepareApprovalDecision(
    input: {
      readonly instanceId: string;
      readonly expectedVersion: number;
      readonly principalApproverId: string;
      readonly outcome: 'approved' | 'rejected';
      readonly prepareKey: string;
    },
    extra: McpExtra,
  ): Promise<McpToolResult> {
    return this.prepareApprovalOperation(
      extra,
      ['erp:approval:instance:read', 'erp:approval:task:decide'],
      {
        operation: 'approval.decide',
        instanceId: input.instanceId,
        expectedVersion: input.expectedVersion,
        principalApproverId: input.principalApproverId,
        outcome: input.outcome,
      },
      input.prepareKey,
      'R2',
      ['running'],
    );
  }

  async executeApprovalSubmit(
    operationId: string,
    confirmationCredential: string,
    extra: McpExtra,
  ): Promise<McpToolResult> {
    return this.executeApprovalOperation(
      extra,
      'approval.submit',
      ['erp:approval:instance:submit'],
      operationId,
      confirmationCredential,
    );
  }

  async executeApprovalWithdraw(
    operationId: string,
    confirmationCredential: string,
    extra: McpExtra,
  ): Promise<McpToolResult> {
    return this.executeApprovalOperation(
      extra,
      'approval.withdraw',
      ['erp:approval:instance:submit'],
      operationId,
      confirmationCredential,
    );
  }

  async executeApprovalDecision(
    operationId: string,
    confirmationCredential: string,
    extra: McpExtra,
  ): Promise<McpToolResult> {
    return this.executeApprovalOperation(
      extra,
      'approval.decide',
      ['erp:approval:task:decide'],
      operationId,
      confirmationCredential,
    );
  }

  private async prepareApprovalOperation(
    extra: McpExtra,
    requiredScopes: readonly string[],
    command: ApprovalMcpCommand,
    prepareKey: string,
    riskLevel: 'R1' | 'R2',
    allowedStatuses: readonly string[],
  ): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    return this.run(identity, async () => {
      const missing = requiredScopes.find((scope) => !identity.scopes.includes(scope));
      if (missing !== undefined) {
        await this.auditTool(identity, `${command.operation.replace('.', '_')}_prepare`, riskLevel, 'denied');
        return scopeError(missing);
      }
      const instance = await this.approvals.getInstance(command.instanceId);
      const independentDecision = command.operation !== 'approval.decide' || (
        command.principalApproverId !== instance.initiatorId &&
        identity.actorId !== instance.initiatorId
      );
      if (instance.version !== command.expectedVersion || !allowedStatuses.includes(instance.status)) {
        await this.auditTool(
          identity,
          `${command.operation.replace('.', '_')}_prepare`,
          riskLevel,
          'failure',
          { stateChanged: true },
        );
        return businessError('APPROVAL_PREPARE_STATE_CHANGED', '审批状态或版本已变化，请刷新后重试');
      }
      if (!independentDecision) {
        await this.auditTool(
          identity,
          `${command.operation.replace('.', '_')}_prepare`,
          riskLevel,
          'denied',
          { independentApproval: false },
        );
        return businessError('APPROVAL_R2_INDEPENDENCE_REQUIRED', 'R2 决策必须由发起人之外的独立审批人处理');
      }
      const prepared = await this.confirmations.prepare(identity, prepareKey, command, riskLevel);
      await this.auditTool(
        identity,
        `${command.operation.replace('.', '_')}_prepare`,
        riskLevel,
        'success',
        { operationId: prepared.operationId, digest: prepared.digest },
      );
      return preparedResult(prepared);
    });
  }

  private async executeApprovalOperation(
    extra: McpExtra,
    operation: ApprovalMcpOperation,
    requiredScopes: readonly string[],
    operationId: string,
    confirmationCredential: string,
  ): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    const riskLevel = operation === 'approval.decide' ? 'R2' : 'R1';
    return this.run(identity, async () => {
      const missing = requiredScopes.find((scope) => !identity.scopes.includes(scope));
      if (missing !== undefined) {
        await this.auditTool(identity, `${operation.replace('.', '_')}_execute`, riskLevel, 'denied');
        return scopeError(missing);
      }
      const claimed = await this.confirmations.claim(
        identity,
        operation,
        operationId,
        confirmationCredential,
      );
      if (claimed.replayResult !== null) {
        await this.auditTool(
          identity,
          `${operation.replace('.', '_')}_execute`,
          riskLevel,
          'success',
          { operationId, replayed: true },
        );
        return structuredResult(claimed.replayResult);
      }
      try {
        if (!isApprovalCommand(claimed.command) || claimed.command.operation !== operation) {
          throw new Error('MCP_APPROVAL_COMMAND_TYPE_MISMATCH');
        }
        const result = await this.dispatchApprovalCommand(claimed.command, operationId);
        await this.confirmations.complete(operationId, result);
        await this.auditTool(
          identity,
          `${operation.replace('.', '_')}_execute`,
          riskLevel,
          'success',
          { operationId, replayed: false },
        );
        return structuredResult(result);
      } catch (error) {
        await this.confirmations.release(operationId);
        await this.auditTool(
          identity,
          `${operation.replace('.', '_')}_execute`,
          riskLevel,
          'failure',
          { operationId },
        );
        throw error;
      }
    });
  }

  private async dispatchApprovalCommand(
    command: ApprovalMcpCommand,
    operationId: string,
  ): Promise<Record<string, unknown>> {
    const idempotencyKey = `mcp:${operationId}`;
    switch (command.operation) {
      case 'approval.submit':
        return this.approvals.submitInstance(
          command.instanceId, command.expectedVersion, idempotencyKey,
        );
      case 'approval.withdraw':
        return this.approvals.withdrawInstance(
          command.instanceId, command.expectedVersion, idempotencyKey,
        );
      case 'approval.decide':
        return this.approvals.decideConfirmedInstance(
          command.instanceId,
          command.expectedVersion,
          command.principalApproverId,
          command.outcome,
          idempotencyKey,
        );
    }
  }

  private async getRecruitmentResource<T extends Record<string, unknown>>(
    extra: McpExtra,
    tool: string,
    requiredScope: string,
    field: string,
    loader: () => Promise<T>,
  ): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    return this.run(identity, async () => {
      if (!identity.scopes.includes(requiredScope)) {
        await this.auditTool(identity, tool, 'R0', 'denied');
        return scopeError(requiredScope);
      }
      const resource = await loader();
      const data: Record<string, unknown> = { [field]: resource };
      await this.auditTool(identity, tool, 'R0', 'success');
      return structuredResult(data);
    });
  }

  private async deniedRecruitmentPrepare(
    identity: McpIdentity,
    tool: string,
    riskLevel: 'R1' | 'R2',
    missingScope: string,
  ): Promise<McpToolResult> {
    await this.auditTool(identity, tool, riskLevel, 'denied');
    return scopeError(missingScope);
  }

  private async changed(
    identity: McpIdentity,
    tool: string,
    riskLevel: 'R1' | 'R2',
    message: string,
  ): Promise<McpToolResult> {
    await this.auditTool(identity, tool, riskLevel, 'failure', { stateChanged: true });
    return businessError('RECRUITMENT_PREPARE_STATE_CHANGED', `${message}，请刷新后重试`);
  }

  private async prepareRecruitmentCommand(
    identity: McpIdentity,
    prepareKey: string,
    command: RecruitmentMcpCommand,
    riskLevel: 'R1' | 'R2',
    tool: string,
  ): Promise<McpToolResult> {
    const prepared = await this.confirmations.prepare(identity, prepareKey, command, riskLevel);
    await this.auditTool(identity, tool, riskLevel, 'success', {
      operationId: prepared.operationId, digest: prepared.digest,
    });
    return preparedResult(prepared);
  }

  private async executeRecruitmentOperation(
    extra: McpExtra,
    operation: RecruitmentMcpOperation,
    requiredScopes: readonly string[],
    operationId: string,
    confirmationCredential: string,
  ): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    const riskLevel = operation === 'recruitment.position.transition' ? 'R1' : 'R2';
    return this.run(identity, async () => {
      const missing = requiredScopes.find((scope) => !identity.scopes.includes(scope));
      if (missing !== undefined) {
        await this.auditTool(identity, `${operation.replaceAll('.', '_')}_execute`, riskLevel, 'denied');
        return scopeError(missing);
      }
      const claimed = await this.confirmations.claim(
        identity, operation, operationId, confirmationCredential,
      );
      if (claimed.replayResult !== null) {
        await this.auditTool(
          identity, `${operation.replaceAll('.', '_')}_execute`, riskLevel, 'success',
          { operationId, replayed: true },
        );
        return structuredResult(claimed.replayResult);
      }
      try {
        if (!isRecruitmentCommand(claimed.command) || claimed.command.operation !== operation) {
          throw new Error('MCP_RECRUITMENT_COMMAND_TYPE_MISMATCH');
        }
        const result = await this.dispatchRecruitmentCommand(claimed.command, operationId);
        await this.confirmations.complete(operationId, result);
        await this.auditTool(
          identity, `${operation.replaceAll('.', '_')}_execute`, riskLevel, 'success',
          { operationId, replayed: false },
        );
        return structuredResult(result);
      } catch (error) {
        await this.confirmations.release(operationId);
        await this.auditTool(
          identity, `${operation.replaceAll('.', '_')}_execute`, riskLevel, 'failure',
          { operationId },
        );
        throw error;
      }
    });
  }

  private async dispatchRecruitmentCommand(
    command: RecruitmentMcpCommand,
    operationId: string,
  ): Promise<Record<string, unknown>> {
    const key = `mcp:${operationId}`;
    switch (command.operation) {
      case 'recruitment.requisition.submit':
        return this.recruitmentManagement.submitRequisition(
          command.requisitionId, command.expectedVersion, key,
        );
      case 'recruitment.position.transition':
        return this.recruitmentManagement.transitionPosition(
          command.positionId, command.expectedVersion, key, command.targetStatus,
        );
      case 'recruitment.offer.request_send':
        return this.recruitmentOffers.requestSend(command.offerId, command.expectedVersion, key);
    }
  }

  private async auditTool(
    identity: McpIdentity,
    tool: string,
    riskLevel: 'R0' | 'R1' | 'R2',
    outcome: 'success' | 'denied' | 'failure',
    metadata: Readonly<Record<string, string | number | boolean>> = {},
  ): Promise<void> {
    await this.audit.record({
      action: `mcp.tool.${tool}`,
      resourceType: 'mcp_tool',
      resourceId: tool,
      riskLevel,
      outcome,
      metadata: { clientId: identity.clientId, protocol: '2025-11-25', ...metadata },
    });
  }

  private run<T>(identity: McpIdentity, operation: () => Promise<T>): Promise<T> {
    return this.tenantContext.run(
      {
        tenant: {
          tenantId: identity.tenantId,
          source: identity.actorType === 'user' ? 'access_token' : 'service_identity',
        },
        actor: {
          actorId: identity.actorId,
          actorType: identity.actorType,
          tenantId: identity.tenantId,
          roleCodes: identity.roleCodes,
          scopes: identity.scopes,
          departmentIds: identity.departmentIds,
          traceId: identity.traceId,
        },
      },
      operation,
    );
  }
}

function scopeError(scope: string): McpToolResult {
  return {
    isError: true,
    content: [{
      type: 'text',
      text: JSON.stringify({ code: 'AUTH_INSUFFICIENT_SCOPE', message: `需要 ${scope}` }),
    }],
  };
}

function businessError(code: string, message: string): McpToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ code, message }) }],
  };
}

function preparedResult(prepared: McpPreparedOperation): McpToolResult {
  const data: Record<string, unknown> = { ...prepared };
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function structuredResult(data: Record<string, unknown>): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function exportResourceResult(data: Record<string, unknown>): McpToolResult {
  const exportValue = data.export;
  const resourceUri = typeof exportValue === 'object' && exportValue !== null &&
    typeof (exportValue as { resourceUri?: unknown }).resourceUri === 'string'
    ? (exportValue as { resourceUri: string }).resourceUri : '';
  if (!resourceUri.startsWith('erp://analytics/exports/')) {
    throw new Error('MCP_ANALYTICS_EXPORT_RESOURCE_INVALID');
  }
  return {
    content: [
      { type: 'text', text: JSON.stringify(data) },
      {
        type: 'resource_link', uri: resourceUri, name: 'management-dashboard-export',
        title: '管理驾驶舱异步导出', description: '轮询此资源直到状态为 ready。',
        mimeType: 'application/json',
      },
    ],
    structuredContent: data,
  };
}

function isApprovalCommand(command: McpCommand): command is ApprovalMcpCommand {
  return command.operation.startsWith('approval.');
}

function isRecruitmentCommand(command: McpCommand): command is RecruitmentMcpCommand {
  return command.operation.startsWith('recruitment.');
}

function isAttendanceCommand(command: McpCommand): command is AttendanceMcpCommand {
  return command.operation === 'attendance.correction.request';
}

function isAnalyticsCommand(command: McpCommand): command is AnalyticsMcpCommand {
  return command.operation === 'analytics.management_dashboard.export';
}
