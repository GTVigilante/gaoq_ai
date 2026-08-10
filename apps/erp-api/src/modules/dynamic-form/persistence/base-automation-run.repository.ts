import { ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId, ULID_PATTERN } from '@gaoq/shared-utils';
import type { ClientSession, Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { AutomationExecutionPlan } from '../domain/base-automation-interpreter.js';
import { parseAutomationActions } from '../domain/multidimensional-base.js';
import { BaseAutomationRunRecord, type BaseAutomationActionResult, type BaseAutomationRunDocument } from './base-automation-run.schema.js';

export interface BaseAutomationRun {
  readonly id: string;
  readonly tenantId: string;
  readonly baseId: string;
  readonly baseVersion: number;
  readonly automationId: string;
  readonly automationName: string;
  readonly sourceTableId: string;
  readonly sourceRecordId: string;
  readonly sourceRecordVersion: number;
  readonly triggerType: AutomationExecutionPlan['triggerType'];
  readonly actions: AutomationExecutionPlan['actions'];
  readonly planHash: string;
  readonly status: 'pending' | 'processing' | 'completed' | 'manual_review';
  readonly nextActionIndex: number;
  readonly actionResults: readonly BaseAutomationActionResult[];
  readonly failureCode: string | null;
}

@Injectable()
export class BaseAutomationRunRepository {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(BaseAutomationRunRecord.name) private readonly records: Model<BaseAutomationRunDocument>,
  ) {}

  async schedule(plan: AutomationExecutionPlan, session: ClientSession): Promise<void> {
    const tenantId = this.context.getTenantRequired().tenantId;
    const identity = {
      tenantId, baseId: plan.baseId, automationId: plan.automationId,
      sourceRecordId: plan.sourceRecordId, sourceRecordVersion: plan.sourceRecordVersion,
      triggerType: plan.triggerType,
    };
    await this.records.updateOne(identity, { $setOnInsert: {
      id: createEventId(new Date(plan.occurredAt)), tenantId,
      baseId: plan.baseId, baseVersion: plan.baseVersion,
      automationId: plan.automationId, automationName: plan.automationName,
      sourceTableId: plan.sourceTableId, sourceRecordId: plan.sourceRecordId,
      sourceRecordVersion: plan.sourceRecordVersion, triggerType: plan.triggerType,
      actions: structuredClone(plan.actions), planHash: plan.planHash,
      status: 'pending', nextActionIndex: 0, actionResults: [], failureCode: null,
      occurredAt: new Date(plan.occurredAt),
    } }, { upsert: true, session, setDefaultsOnInsert: true });
    const stored = await this.records.findOne(identity).select('planHash -_id').lean().session(session).exec();
    if (stored === null || stored.planHash !== plan.planHash) throw new ConflictException({
      code: 'BASE_AUTOMATION_PLAN_IMMUTABLE', message: '同一来源版本的自动化计划不可改写',
    });
  }

  async listRelayableGlobal(now: Date, limit = 100): Promise<readonly { readonly id: string; readonly tenantId: string }[]> {
    const stale = new Date(now.getTime() - 5 * 60_000);
    const rows = await this.records.find({ $or: [{ status: 'pending' }, { status: 'processing', updatedAt: { $lte: stale } }] })
      .sort({ updatedAt: 1, id: 1 }).limit(limit).select('id tenantId -_id').lean().exec();
    return Object.freeze(rows.map((row) => Object.freeze({ id: row.id, tenantId: row.tenantId })));
  }

  async find(id: string): Promise<BaseAutomationRun | null> {
    const tenantId = this.context.getTenantRequired().tenantId;
    const row = await this.records.findOne({ tenantId, id }).select('-_id').lean().exec();
    if (row === null) return null;
    const actions = parseAutomationActions(row.actions);
    if (row.tenantId !== tenantId || row.id !== id || !ULID_PATTERN.test(row.baseId) ||
      !ULID_PATTERN.test(row.automationId) || !ULID_PATTERN.test(row.sourceTableId) ||
      !ULID_PATTERN.test(row.sourceRecordId) || !Number.isSafeInteger(row.baseVersion) || row.baseVersion < 1 ||
      !Number.isSafeInteger(row.sourceRecordVersion) || row.sourceRecordVersion < 1 ||
      !/^[A-Za-z0-9_-]{43}$/.test(row.planHash) || !['pending', 'processing', 'completed', 'manual_review'].includes(row.status) ||
      !Number.isSafeInteger(row.nextActionIndex) || row.nextActionIndex < 0 || row.nextActionIndex > actions.length ||
      row.actionResults.length !== row.nextActionIndex ||
      row.actionResults.some((result, index) => !validActionResult(result, actions[index], index)) ||
      (row.status === 'pending' && row.nextActionIndex !== 0) ||
      (row.status === 'completed' && row.nextActionIndex !== actions.length) ||
      (row.status !== 'manual_review' && row.failureCode !== null) ||
      (row.status === 'manual_review' && (typeof row.failureCode !== 'string' || !/^[A-Z][A-Z0-9_]{2,127}$/.test(row.failureCode)))) {
      throw new Error('BASE_AUTOMATION_RUN_STATE_INVALID');
    }
    return Object.freeze({
      id: row.id, tenantId: row.tenantId, baseId: row.baseId, baseVersion: row.baseVersion,
      automationId: row.automationId, automationName: row.automationName,
      sourceTableId: row.sourceTableId, sourceRecordId: row.sourceRecordId,
      sourceRecordVersion: row.sourceRecordVersion, triggerType: row.triggerType,
      actions, planHash: row.planHash,
      status: row.status, nextActionIndex: row.nextActionIndex,
      actionResults: Object.freeze(structuredClone(row.actionResults)), failureCode: row.failureCode,
    });
  }

  async markProcessing(id: string): Promise<void> {
    const result = await this.records.updateOne({ tenantId: this.tenant(), id, status: { $in: ['pending', 'processing'] } }, { $set: { status: 'processing', failureCode: null } });
    if (result.matchedCount !== 1) throw new ConflictException({ code: 'BASE_AUTOMATION_RUN_NOT_EXECUTABLE', message: '自动化运行已终结或不存在' });
  }

  async advance(id: string, expectedIndex: number, result: BaseAutomationActionResult): Promise<void> {
    const run = await this.find(id);
    if (run === null || run.nextActionIndex !== expectedIndex || run.status !== 'processing' || run.actionResults.length !== expectedIndex) throw new ConflictException({ code: 'BASE_AUTOMATION_RUN_VERSION_CONFLICT', message: '自动化运行进度已变化' });
    const next = expectedIndex + 1;
    const updated = await this.records.updateOne({ tenantId: this.tenant(), id, status: 'processing', nextActionIndex: expectedIndex }, {
      $set: { nextActionIndex: next, status: next === run.actions.length ? 'completed' : 'processing' },
      $push: { actionResults: structuredClone(result) },
    });
    if (updated.matchedCount !== 1) throw new ConflictException({ code: 'BASE_AUTOMATION_RUN_VERSION_CONFLICT', message: '自动化运行进度已变化' });
  }

  async manualReview(id: string, failureCode: string): Promise<void> {
    if (!/^[A-Z][A-Z0-9_]{2,127}$/.test(failureCode)) throw new Error('BASE_AUTOMATION_FAILURE_CODE_INVALID');
    await this.records.updateOne({ tenantId: this.tenant(), id, status: { $in: ['pending', 'processing'] } }, { $set: { status: 'manual_review', failureCode } });
  }

  private tenant(): string { return this.context.getTenantRequired().tenantId; }
}

function validActionResult(
  result: BaseAutomationActionResult,
  action: AutomationExecutionPlan['actions'][number] | undefined,
  index: number,
): boolean {
  if (action === undefined || result === null || typeof result !== 'object' ||
    result.index !== index || result.type !== action.type ||
    !ULID_PATTERN.test(result.resourceId) || !Number.isSafeInteger(result.version) || result.version < 1) return false;
  return result.resourceType === (action.type === 'start_approval' ? 'approval_instance' : 'dynamic_form_record');
}
