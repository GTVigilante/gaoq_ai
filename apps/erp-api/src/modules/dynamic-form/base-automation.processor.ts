import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { Job } from 'bullmq';

import { AuditService } from '../../core/audit/audit.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import { DynamicFormApprovalBridgeService } from './application/dynamic-form-approval-bridge.service.js';
import { DynamicFormService } from './application/dynamic-form.service.js';
import {
  BASE_AUTOMATION_EXECUTE_JOB, BASE_AUTOMATION_QUEUE, BASE_AUTOMATION_RELAY_JOB,
  baseAutomationJobId, type BaseAutomationJobData,
} from './base-automation.queue.js';
import { BaseAutomationQueueService } from './base-automation-queue.service.js';
import { BaseAutomationRunRepository } from './persistence/base-automation-run.repository.js';
import type { BaseAutomationActionResult } from './persistence/base-automation-run.schema.js';
import type { MultidimensionalAutomationAction } from './domain/multidimensional-base.js';

const TENANT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** 自动化 Worker：账本驱动、逐动作幂等；未登记通知/连接器进入人工复核，不执行副作用。 */
@Processor(BASE_AUTOMATION_QUEUE, { concurrency: 4, limiter: { max: 20, duration: 1_000 } })
export class BaseAutomationProcessor extends WorkerHost {
  private readonly logger = new Logger(BaseAutomationProcessor.name);

  constructor(
    private readonly context: TenantContextService,
    private readonly runs: BaseAutomationRunRepository,
    private readonly queue: BaseAutomationQueueService,
    private readonly forms: DynamicFormService,
    private readonly approvals: DynamicFormApprovalBridgeService,
    private readonly audit: AuditService,
  ) { super(); }

  override async process(job: Job<BaseAutomationJobData>): Promise<number> {
    if (job.name === BASE_AUTOMATION_RELAY_JOB) {
      if (Reflect.ownKeys(job.data).length !== 0) throw new Error('BASE_AUTOMATION_RELAY_JOB_INVALID');
      const relayable = await this.runs.listRelayableGlobal(new Date());
      for (const run of relayable) await this.queue.enqueue(run.tenantId, run.id);
      return relayable.length;
    }
    if (job.name !== BASE_AUTOMATION_EXECUTE_JOB || !isRunJob(job.data) ||
      job.id !== baseAutomationJobId(job.data.tenantId, job.data.runId)) throw new Error('BASE_AUTOMATION_JOB_INVALID');
    const data = job.data;
    await this.context.run({
      tenant: { tenantId: data.tenantId, source: 'service_identity' },
      actor: {
        actorId: 'system:base-automation', actorType: 'system_job', tenantId: data.tenantId,
        roleCodes: ['BASE_AUTOMATION_WORKER'],
        scopes: [
          'erp:forms:data:read', 'erp:forms:data:write', 'erp:approval:instance:submit',
          'erp:approval:dynamic_form:automate',
          'erp:op:operating_summary:read',
        ],
        departmentIds: [], traceId: String(job.id),
      },
    }, async () => {
      try {
        await this.executeRun(data.runId);
      } catch (error) {
        const attempts = typeof job.opts.attempts === 'number' ? job.opts.attempts : 1;
        if (job.attemptsMade + 1 >= attempts) await this.runs.manualReview(data.runId, failureCode(error));
        const code = failureCode(error);
        throw new Error(code, { cause: error });
      }
    });
    return 1;
  }

  private async executeRun(runId: string): Promise<void> {
    const run = await this.runs.find(runId);
    if (run === null || run.status === 'completed' || run.status === 'manual_review') return;
    if (run.actions.some((action) => action.type === 'notify' || action.type === 'connector_call')) {
      await this.runs.manualReview(run.id, 'BASE_AUTOMATION_ADAPTER_REQUIRED');
      return;
    }
    const updateIndex = run.actions.findIndex((action) => action.type === 'update_record');
    if (updateIndex >= 0 && updateIndex !== run.actions.length - 1) {
      await this.runs.manualReview(run.id, 'BASE_AUTOMATION_UPDATE_MUST_BE_LAST');
      return;
    }
    await this.runs.markProcessing(run.id);
    const source = await this.forms.getApprovalSource(
      run.sourceTableId, run.sourceRecordId, run.sourceRecordVersion,
    );
    for (let index = run.nextActionIndex; index < run.actions.length; index += 1) {
      const action = run.actions[index]!;
      const result = await this.executeAction(run.id, index, action, source.record.values, run.sourceTableId, run.sourceRecordId, run.sourceRecordVersion);
      await this.runs.advance(run.id, index, result);
      try {
        await this.audit.record({
          action: 'base.automation.action.execute', resourceType: result.resourceType,
          resourceId: result.resourceId, riskLevel: 'R2', outcome: 'success',
          metadata: { automationRunId: run.id, actionIndex: index, actionType: action.type, version: result.version },
        });
      } catch {
        this.logger.error({ code: 'BASE_AUTOMATION_COMMITTED_AUDIT_FAILED', automationRunId: run.id, actionIndex: index });
      }
    }
  }

  private async executeAction(
    runId: string,
    index: number,
    action: MultidimensionalAutomationAction,
    sourceValues: Readonly<Record<string, unknown>>,
    sourceTableId: string,
    sourceRecordId: string,
    sourceRecordVersion: number,
  ): Promise<BaseAutomationActionResult> {
    const key = `base-auto-${runId}-${index}`;
    if (action.type === 'start_approval') {
      const result = await this.approvals.submitRecord(sourceTableId, sourceRecordId, sourceRecordVersion, key);
      return Object.freeze({ index, type: action.type, resourceType: 'approval_instance', resourceId: result.instance.id, version: result.instance.version });
    }
    if (action.type === 'create_record') {
      const values = mapValues(action.fieldMapping, sourceValues);
      const result = await this.forms.createRecord(action.targetTableId, key, { values });
      return Object.freeze({ index, type: action.type, resourceType: 'dynamic_form_record', resourceId: result.record.id, version: result.record.version });
    }
    if (action.type === 'update_record') {
      const values = { ...sourceValues, ...mapValues(action.fieldMapping, sourceValues) };
      const result = await this.forms.updateRecord(sourceTableId, sourceRecordId, sourceRecordVersion, key, { values });
      return Object.freeze({ index, type: action.type, resourceType: 'dynamic_form_record', resourceId: result.record.id, version: result.record.version });
    }
    throw new Error('BASE_AUTOMATION_ACTION_NOT_EXECUTABLE');
  }
}

function mapValues(mapping: Readonly<Record<string, string>>, source: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [target, from] of Object.entries(mapping)) {
    if (!Object.hasOwn(source, from)) throw new Error('BASE_AUTOMATION_SOURCE_VALUE_MISSING');
    values[target] = structuredClone(source[from]);
  }
  return values;
}

function isRunJob(value: BaseAutomationJobData): value is { readonly tenantId: string; readonly runId: string } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Reflect.ownKeys(value).length === 2 &&
    typeof (value as { tenantId?: unknown }).tenantId === 'string' && TENANT.test((value as { tenantId: string }).tenantId) &&
    typeof (value as { runId?: unknown }).runId === 'string' && ULID_PATTERN.test((value as { runId: string }).runId);
}

function failureCode(error: unknown): string {
  const candidate = error as { readonly response?: { readonly code?: unknown }; readonly code?: unknown };
  const code = candidate.response?.code ?? candidate.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,127}$/.test(code)
    ? code
    : 'BASE_AUTOMATION_EXECUTION_FAILED';
}
