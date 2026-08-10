import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import type { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import type { DynamicFormApprovalBridgeService } from './application/dynamic-form-approval-bridge.service.js';
import type { DynamicFormService } from './application/dynamic-form.service.js';
import { BaseAutomationProcessor } from './base-automation.processor.js';
import { BASE_AUTOMATION_EXECUTE_JOB, BASE_AUTOMATION_RELAY_JOB, baseAutomationJobId, type BaseAutomationJobData } from './base-automation.queue.js';
import type { BaseAutomationQueueService } from './base-automation-queue.service.js';
import type { BaseAutomationRun, BaseAutomationRunRepository } from './persistence/base-automation-run.repository.js';

const RUN_ID = '01K00000000000000000000001';
const FORM_ID = '01K00000000000000000000002';
const RECORD_ID = '01K00000000000000000000003';

function run(actions: BaseAutomationRun['actions']): BaseAutomationRun {
  return {
    id: RUN_ID, tenantId: 'tenant-001', baseId: '01K00000000000000000000004', baseVersion: 1,
    automationId: '01K00000000000000000000005', automationName: '自动审批',
    sourceTableId: FORM_ID, sourceRecordId: RECORD_ID, sourceRecordVersion: 2,
    triggerType: 'record_updated', actions, planHash: 'a'.repeat(43), status: 'pending',
    nextActionIndex: 0, actionResults: [], failureCode: null,
  };
}

function setup(current = run([{ type: 'start_approval' }])) {
  const context = { run: (_trusted: unknown, callback: () => Promise<unknown>) => callback() } as unknown as TenantContextService;
  const runs = {
    listRelayableGlobal: vi.fn().mockResolvedValue([{ id: RUN_ID, tenantId: 'tenant-001' }]),
    find: vi.fn().mockResolvedValue(current), markProcessing: vi.fn(), advance: vi.fn(), manualReview: vi.fn(),
  };
  const queue = { enqueue: vi.fn() };
  const forms = { getApprovalSource: vi.fn().mockResolvedValue({ record: { values: { name: '项目 A' } } }), createRecord: vi.fn(), updateRecord: vi.fn() };
  const approvals = { submitRecord: vi.fn().mockResolvedValue({ instance: { id: '01K00000000000000000000006', version: 2 } }) };
  const audit = { record: vi.fn() };
  return {
    runs, queue, forms, approvals, audit,
    processor: new BaseAutomationProcessor(
      context, runs as unknown as BaseAutomationRunRepository,
      queue as unknown as BaseAutomationQueueService,
      forms as unknown as DynamicFormService,
      approvals as unknown as DynamicFormApprovalBridgeService,
      audit as unknown as AuditService,
    ),
  };
}

function job(name: string, data: BaseAutomationJobData, id: string): Job<BaseAutomationJobData> {
  return { name, data, id, attemptsMade: 0, opts: { attempts: 8 } } as Job<BaseAutomationJobData>;
}

describe('BaseAutomationProcessor', () => {
  it('周期 relay 只投递运行标识和租户', async () => {
    const store = setup();
    await expect(store.processor.process(job(BASE_AUTOMATION_RELAY_JOB, {}, 'relay'))).resolves.toBe(1);
    expect(store.queue.enqueue).toHaveBeenCalledWith('tenant-001', RUN_ID);
  });

  it('审批动作复用表单审批桥并推进持久化运行账本', async () => {
    const store = setup();
    const data = { tenantId: 'tenant-001', runId: RUN_ID };
    await expect(store.processor.process(job(BASE_AUTOMATION_EXECUTE_JOB, data, baseAutomationJobId(data.tenantId, data.runId)))).resolves.toBe(1);
    expect(store.runs.markProcessing).toHaveBeenCalledWith(RUN_ID);
    expect(store.approvals.submitRecord).toHaveBeenCalledWith(FORM_ID, RECORD_ID, 2, `base-auto-${RUN_ID}-0`);
    expect(store.runs.advance).toHaveBeenCalledWith(RUN_ID, 0, expect.objectContaining({ resourceType: 'approval_instance' }));
  });

  it('未登记连接器在任何副作用前进入人工复核', async () => {
    const store = setup(run([{ type: 'connector_call', connectorId: 'op', operation: 'unknown' }]));
    const data = { tenantId: 'tenant-001', runId: RUN_ID };
    await store.processor.process(job(BASE_AUTOMATION_EXECUTE_JOB, data, baseAutomationJobId(data.tenantId, data.runId)));
    expect(store.runs.manualReview).toHaveBeenCalledWith(RUN_ID, 'BASE_AUTOMATION_ADAPTER_REQUIRED');
    expect(store.forms.getApprovalSource).not.toHaveBeenCalled();
    expect(store.runs.markProcessing).not.toHaveBeenCalled();
  });
});
