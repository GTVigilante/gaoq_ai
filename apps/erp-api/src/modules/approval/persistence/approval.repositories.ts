import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession, Model } from 'mongoose';
import { z } from 'zod';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { evaluateApprovalCondition, type ApprovalFormData } from '../domain/condition.js';
import { ApprovalDomainError } from '../domain/approval.errors.js';
import type {
  ApprovalAction,
  ApprovalInstance,
  ResolvedApprovalNode,
} from '../domain/instance.js';
import {
  currentApprovalNode,
} from '../domain/instance.js';
import type {
  ApprovalTemplate,
  ApprovalTemplateDefinition,
  ApprovalTemplateSnapshot,
} from '../domain/template.js';
import {
  hashApprovalJson,
  validateAndFreezeApprovalFormData,
  validateAndFreezeApprovalTemplateDefinition,
} from '../domain/template.js';
import {
  ApprovalDataCryptoService,
  type ProtectedApprovalFormData,
} from './approval-data-crypto.service.js';
import {
  ApprovalActionRecord,
  type ApprovalActionDocument,
  ApprovalDelegationRecord,
  type ApprovalDelegationDocument,
  ApprovalInstanceRecord,
  type ApprovalInstanceDocument,
  ApprovalTemplateRecord,
  type ApprovalTemplateDocument,
} from './approval.schemas.js';

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const isoDate = z.string().datetime({ offset: true });
const decisionSchema = z.object({
  principalApproverId: identifier,
  decidedBy: identifier,
  outcome: z.enum(['approved', 'rejected']),
  decidedAt: isoDate,
  delegated: z.boolean(),
}).strict();
const resolvedNodeSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(256),
  type: z.enum(['approval', 'copy']),
  approvalMode: z.enum(['all', 'any']).nullable(),
  actorIds: z.array(identifier).max(100),
  decisions: z.array(decisionSchema).max(100),
}).strict();
const resolvedNodesEnvelopeSchema = z.object({
  nodes: z.array(resolvedNodeSchema).max(50),
}).strict();
const snapshotSchema = z.object({
  templateId: identifier,
  templateCode: z.string().min(1).max(64),
  templateName: z.string().min(1).max(256),
  riskLevel: z.enum(['R1', 'R2']),
  revision: z.number().int().positive().safe(),
  definition: z.unknown(),
  definitionHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  approvedBy: identifier,
  publishedAt: isoDate,
}).strict();

export class ApprovalWriteConflictError extends Error {
  constructor() {
    super('审批数据版本冲突');
    this.name = 'ApprovalWriteConflictError';
  }
}

abstract class TenantBoundApprovalRepository {
  constructor(protected readonly context: TenantContextService) {}

  protected tenantId(): string {
    return this.context.getTenantRequired().tenantId;
  }

  protected assertTenant(tenantId: string): void {
    if (tenantId !== this.tenantId()) throw new Error('审批仓储拒绝跨租户实体');
  }
}

@Injectable()
export class ApprovalTemplateRepository extends TenantBoundApprovalRepository {
  constructor(
    context: TenantContextService,
    @InjectModel(ApprovalTemplateRecord.name)
    private readonly records: Model<ApprovalTemplateDocument>,
  ) {
    super(context);
  }

  async findById(id: string, session?: ClientSession): Promise<ApprovalTemplate | null> {
    const query = this.records.findOne({ tenantId: this.tenantId(), id });
    if (session !== undefined) query.session(session);
    const record = await query.lean().exec();
    return record === null ? null : this.toDomain(record);
  }

  async findPublishedByCode(code: string, session?: ClientSession): Promise<ApprovalTemplate | null> {
    const query = this.records.findOne({ tenantId: this.tenantId(), code, status: 'published' });
    if (session !== undefined) query.session(session);
    const record = await query.lean().exec();
    return record === null ? null : this.toDomain(record);
  }

  async findLatestByCode(code: string, session?: ClientSession): Promise<ApprovalTemplate | null> {
    const query = this.records.findOne({ tenantId: this.tenantId(), code }).sort({ revision: -1 });
    if (session !== undefined) query.session(session);
    const record = await query.lean().exec();
    return record === null ? null : this.toDomain(record);
  }

  async insert(template: ApprovalTemplate, session: ClientSession): Promise<void> {
    this.assertTenant(template.tenantId);
    await this.records.create([this.toRecord(template)], { session });
  }

  async replace(
    template: ApprovalTemplate,
    expectedVersion: number,
    session: ClientSession,
  ): Promise<void> {
    this.assertTenant(template.tenantId);
    const record = this.toRecord(template);
    const result = await this.records.updateOne(
      { tenantId: this.tenantId(), id: template.id, version: expectedVersion },
      { $set: {
        name: record.name,
        riskLevel: record.riskLevel,
        status: record.status,
        definitionJson: record.definitionJson,
        definitionHash: record.definitionHash,
        approvedBy: record.approvedBy,
        publishedAt: record.publishedAt,
        retiredAt: record.retiredAt,
        version: record.version,
        updatedBy: record.updatedBy,
        updatedAt: record.updatedAt,
      } },
      { session, timestamps: false },
    );
    if (result.matchedCount !== 1) throw new ApprovalWriteConflictError();
  }

  private toRecord(template: ApprovalTemplate): Record<string, unknown> {
    return {
      id: template.id,
      tenantId: template.tenantId,
      code: template.code,
      name: template.name,
      riskLevel: template.riskLevel,
      revision: template.revision,
      status: template.status,
      definitionJson: JSON.stringify(template.definition),
      definitionHash: template.definitionHash,
      approvedBy: template.approvedBy,
      publishedAt: toDate(template.publishedAt),
      retiredAt: toDate(template.retiredAt),
      version: template.version,
      createdBy: template.createdBy,
      updatedBy: template.updatedBy,
      createdAt: new Date(template.createdAt),
      updatedAt: new Date(template.updatedAt),
    };
  }

  private toDomain(record: ApprovalTemplateRecord): ApprovalTemplate {
    const definition = validateAndFreezeApprovalTemplateDefinition(
      parseJson(record.definitionJson) as ApprovalTemplateDefinition,
    );
    if (hashApprovalJson(definition) !== record.definitionHash) throw integrityError();
    return deepFreeze({
      id: record.id,
      tenantId: record.tenantId,
      code: record.code,
      name: record.name,
      riskLevel: record.riskLevel,
      revision: record.revision,
      status: record.status,
      definition,
      definitionHash: record.definitionHash,
      approvedBy: record.approvedBy,
      publishedAt: toIso(record.publishedAt),
      retiredAt: toIso(record.retiredAt),
      version: record.version,
      createdBy: record.createdBy,
      updatedBy: record.updatedBy,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    });
  }
}

@Injectable()
export class ApprovalInstanceRepository extends TenantBoundApprovalRepository {
  constructor(
    context: TenantContextService,
    @InjectModel(ApprovalInstanceRecord.name)
    private readonly records: Model<ApprovalInstanceDocument>,
    private readonly crypto: ApprovalDataCryptoService,
  ) {
    super(context);
  }

  async findById(id: string, session?: ClientSession): Promise<ApprovalInstance | null> {
    const query = this.records.findOne({ tenantId: this.tenantId(), id });
    if (session !== undefined) query.session(session);
    const record = await query.lean().exec();
    return record === null ? null : this.toDomain(record);
  }

  async findInbox(actorId: string, limit = 50): Promise<readonly ApprovalInstance[]> {
    const records = await this.records.find({
      tenantId: this.tenantId(), status: 'running', currentActorIds: actorId,
    }).sort({ updatedAt: -1, id: 1 }).limit(Math.min(Math.max(limit, 1), 100)).lean().exec();
    return records.map((record) => this.toDomain(record));
  }

  async findInitiated(initiatorId: string, limit = 50): Promise<readonly ApprovalInstance[]> {
    const records = await this.records.find({ tenantId: this.tenantId(), initiatorId })
      .sort({ createdAt: -1, id: 1 }).limit(Math.min(Math.max(limit, 1), 100)).lean().exec();
    return records.map((record) => this.toDomain(record));
  }

  async insert(instance: ApprovalInstance, session: ClientSession): Promise<void> {
    this.assertTenant(instance.tenantId);
    await this.records.create([this.toRecord(instance)], { session });
  }

  async replace(
    instance: ApprovalInstance,
    expectedVersion: number,
    session: ClientSession,
  ): Promise<void> {
    this.assertTenant(instance.tenantId);
    const record = this.toRecord(instance);
    const result = await this.records.updateOne(
      { tenantId: this.tenantId(), id: instance.id, version: expectedVersion },
      { $set: {
        title: record.title,
        status: record.status,
        formDataHash: record.formDataHash,
        formDataKeyId: record.formDataKeyId,
        formDataIv: record.formDataIv,
        formDataCiphertext: record.formDataCiphertext,
        formDataAuthTag: record.formDataAuthTag,
        resolvedNodesJson: record.resolvedNodesJson,
        currentNodeIndex: record.currentNodeIndex,
        currentActorIds: record.currentActorIds,
        version: record.version,
        submittedAt: record.submittedAt,
        completedAt: record.completedAt,
        archivedAt: record.archivedAt,
        updatedAt: record.updatedAt,
      } },
      { session, timestamps: false },
    );
    if (result.matchedCount !== 1) throw new ApprovalWriteConflictError();
  }

  private toRecord(instance: ApprovalInstance): Record<string, unknown> {
    const protectedData = this.crypto.protect(this.cryptoContext(instance), instance.formData);
    return {
      id: instance.id,
      tenantId: instance.tenantId,
      title: instance.title,
      initiatorId: instance.initiatorId,
      status: instance.status,
      templateId: instance.templateSnapshot.templateId,
      templateCode: instance.templateSnapshot.templateCode,
      templateRevision: instance.templateSnapshot.revision,
      riskLevel: instance.templateSnapshot.riskLevel,
      templateSnapshotJson: JSON.stringify(instance.templateSnapshot),
      formDataHash: instance.formDataHash,
      ...protectedData,
      resolvedNodesJson: JSON.stringify({ nodes: instance.resolvedNodes }),
      currentNodeIndex: instance.currentNodeIndex,
      currentActorIds: currentPendingActorIds(instance),
      version: instance.version,
      submittedAt: toDate(instance.submittedAt),
      completedAt: toDate(instance.completedAt),
      archivedAt: toDate(instance.archivedAt),
      createdAt: new Date(instance.createdAt),
      updatedAt: new Date(instance.updatedAt),
    };
  }

  private toDomain(record: ApprovalInstanceRecord): ApprovalInstance {
    const snapshot = parseSnapshot(record.templateSnapshotJson);
    if (
      snapshot.templateId !== record.templateId || snapshot.templateCode !== record.templateCode ||
      snapshot.revision !== record.templateRevision || snapshot.riskLevel !== record.riskLevel
    ) throw integrityError();
    const decrypted = this.crypto.unprotect({
      tenantId: record.tenantId,
      instanceId: record.id,
      definitionHash: snapshot.definitionHash,
    }, protectedData(record));
    if (!isPlainObject(decrypted)) throw integrityError();
    const formData = validateAndFreezeApprovalFormData(
      snapshot.definition,
      decrypted as ApprovalFormData,
    );
    if (hashApprovalJson(formData) !== record.formDataHash) throw integrityError();
    const resolvedNodes = parseResolvedNodes(
      record.resolvedNodesJson,
      snapshot,
      formData,
      record.submittedAt !== null,
    );
    const restored = deepFreeze({
      id: record.id,
      tenantId: record.tenantId,
      title: record.title,
      initiatorId: record.initiatorId,
      status: record.status,
      templateSnapshot: snapshot,
      formData,
      formDataHash: record.formDataHash,
      resolvedNodes,
      currentNodeIndex: record.currentNodeIndex,
      version: record.version,
      submittedAt: toIso(record.submittedAt),
      completedAt: toIso(record.completedAt),
      archivedAt: toIso(record.archivedAt),
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    });
    assertRestoredState(restored);
    if (!sameStrings(currentPendingActorIds(restored), record.currentActorIds)) throw integrityError();
    return restored;
  }

  private cryptoContext(instance: ApprovalInstance): {
    readonly tenantId: string; readonly instanceId: string; readonly definitionHash: string;
  } {
    return {
      tenantId: instance.tenantId,
      instanceId: instance.id,
      definitionHash: instance.templateSnapshot.definitionHash,
    };
  }
}

@Injectable()
export class ApprovalActionRepository extends TenantBoundApprovalRepository {
  constructor(
    context: TenantContextService,
    @InjectModel(ApprovalActionRecord.name) private readonly records: Model<ApprovalActionDocument>,
  ) {
    super(context);
  }

  async append(
    instance: ApprovalInstance,
    action: ApprovalAction,
    session: ClientSession,
  ): Promise<void> {
    this.assertTenant(instance.tenantId);
    const base = {
      actionId: createEventId(new Date(action.occurredAt)),
      tenantId: instance.tenantId,
      instanceId: instance.id,
      aggregateVersion: instance.version,
      actionType: action.type,
      actorId: action.actorId,
      principalApproverId: null,
      nodeId: null,
      outcome: null,
      resultingStatus: null,
      delegated: false,
      fromApproverId: null,
      toApproverId: null,
      addedApproverId: null,
      canceledApproverIds: [],
      occurredAt: new Date(action.occurredAt),
    };
    const details = actionRecordDetails(action);
    await this.records.create([{ ...base, ...details }], { session });
  }

  /** 返回单实例的追加式动作投影；不返回租户字段、表单正文或内部 Mongo 标识。 */
  async findTimeline(instanceId: string): Promise<readonly ApprovalActionProjection[]> {
    const records = await this.records.find({ tenantId: this.tenantId(), instanceId })
      .sort({ aggregateVersion: 1 })
      .limit(501)
      .lean()
      .exec();
    if (records.length > 500) throw integrityError();
    return Object.freeze(records.map((record) => Object.freeze({
      actionId: record.actionId,
      aggregateVersion: record.aggregateVersion,
      actionType: record.actionType,
      actorId: record.actorId,
      principalApproverId: record.principalApproverId,
      nodeId: record.nodeId,
      outcome: record.outcome,
      resultingStatus: record.resultingStatus,
      delegated: record.delegated,
      fromApproverId: record.fromApproverId,
      toApproverId: record.toApproverId,
      addedApproverId: record.addedApproverId,
      canceledApproverIds: Object.freeze([...record.canceledApproverIds]),
      occurredAt: record.occurredAt.toISOString(),
    })));
  }
}

export interface ApprovalActionProjection {
  readonly actionId: string;
  readonly aggregateVersion: number;
  readonly actionType: ApprovalActionRecord['actionType'];
  readonly actorId: string;
  readonly principalApproverId: string | null;
  readonly nodeId: string | null;
  readonly outcome: 'approved' | 'rejected' | null;
  readonly resultingStatus: ApprovalActionRecord['resultingStatus'];
  readonly delegated: boolean;
  readonly fromApproverId: string | null;
  readonly toApproverId: string | null;
  readonly addedApproverId: string | null;
  readonly canceledApproverIds: readonly string[];
  readonly occurredAt: string;
}

@Injectable()
export class ApprovalDelegationRepository extends TenantBoundApprovalRepository {
  constructor(
    context: TenantContextService,
    @InjectModel(ApprovalDelegationRecord.name)
    private readonly records: Model<ApprovalDelegationDocument>,
  ) {
    super(context);
  }

  async isActive(
    principalApproverId: string,
    delegateId: string,
    at: Date,
    session?: ClientSession,
  ): Promise<boolean> {
    const query = this.records.exists({
      tenantId: this.tenantId(), principalApproverId, delegateId, status: 'active',
      validFrom: { $lte: at }, validUntil: { $gt: at },
    });
    if (session !== undefined) query.session(session);
    return await query.exec() !== null;
  }
}

function parseSnapshot(json: string): ApprovalTemplateSnapshot {
  const parsed = snapshotSchema.safeParse(parseJson(json));
  if (!parsed.success) throw integrityError();
  const definition = validateAndFreezeApprovalTemplateDefinition(
    parsed.data.definition as ApprovalTemplateDefinition,
  );
  if (hashApprovalJson(definition) !== parsed.data.definitionHash) throw integrityError();
  return deepFreeze({ ...parsed.data, definition });
}

function parseResolvedNodes(
  json: string,
  snapshot: ApprovalTemplateSnapshot,
  formData: ApprovalFormData,
  submitted: boolean,
): readonly ResolvedApprovalNode[] {
  const parsed = resolvedNodesEnvelopeSchema.safeParse(parseJson(json));
  if (!parsed.success) throw integrityError();
  if (!submitted) {
    if (parsed.data.nodes.length !== 0) throw integrityError();
    return Object.freeze([]);
  }
  const fieldKeys = new Set(snapshot.definition.fields.map((field) => field.key));
  const expectedNodes = snapshot.definition.nodes.filter((node) =>
    node.condition === undefined || evaluateApprovalCondition(node.condition, formData, fieldKeys),
  );
  if (
    parsed.data.nodes.length !== expectedNodes.length ||
    parsed.data.nodes.some((node, index) => node.id !== expectedNodes[index]?.id)
  ) throw integrityError();
  const expected = new Map(expectedNodes.map((node) => [node.id, node]));
  if (new Set(parsed.data.nodes.map((node) => node.id)).size !== parsed.data.nodes.length) {
    throw integrityError();
  }
  for (const node of parsed.data.nodes) {
    const definitionNode = expected.get(node.id);
    if (
      definitionNode === undefined || definitionNode.type !== node.type ||
      (definitionNode.approvalMode ?? null) !== node.approvalMode ||
      new Set(node.actorIds).size !== node.actorIds.length ||
      (node.type === 'approval' && node.actorIds.length < 1) ||
      (node.type === 'copy' && node.decisions.length !== 0)
    ) throw integrityError();
    const principals = new Set<string>();
    for (const decision of node.decisions) {
      if (!node.actorIds.includes(decision.principalApproverId) || principals.has(decision.principalApproverId)) {
        throw integrityError();
      }
      principals.add(decision.principalApproverId);
    }
  }
  return deepFreeze(parsed.data.nodes as readonly ResolvedApprovalNode[]);
}

function assertRestoredState(instance: ApprovalInstance): void {
  if (instance.status === 'draft') {
    if (instance.resolvedNodes.length !== 0 || instance.currentNodeIndex !== null) throw integrityError();
    return;
  }
  if (instance.status === 'withdrawn' || instance.status === 'archived') return;
  const approvalNodes = instance.resolvedNodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => node.type === 'approval');
  const states = approvalNodes.map(({ node }) => decisionState(node));
  if (instance.status === 'approved') {
    if (states.some((state) => state !== 'passed') || instance.currentNodeIndex !== null) {
      throw integrityError();
    }
    return;
  }
  if (instance.status === 'rejected') {
    const rejectedIndex = states.indexOf('rejected');
    if (
      rejectedIndex < 0 || states.slice(0, rejectedIndex).some((state) => state !== 'passed') ||
      states.slice(rejectedIndex + 1).some((state) => state !== 'untouched') ||
      instance.currentNodeIndex !== null
    ) throw integrityError();
    return;
  }
  const currentPosition = approvalNodes.findIndex(({ index }) => index === instance.currentNodeIndex);
  const currentState = states[currentPosition];
  if (
    currentPosition < 0 || (currentState !== 'pending' && currentState !== 'untouched') ||
    states.slice(0, currentPosition).some((state) => state !== 'passed') ||
    states.slice(currentPosition + 1).some((state) => state !== 'untouched')
  ) throw integrityError();
}

function decisionState(
  node: ResolvedApprovalNode,
): 'untouched' | 'pending' | 'passed' | 'rejected' {
  if (node.decisions.length === 0) return 'untouched';
  const approvals = node.decisions.filter((decision) => decision.outcome === 'approved').length;
  const rejections = node.decisions.length - approvals;
  if (node.approvalMode === 'all') {
    if (rejections > 0) return 'rejected';
    return approvals === node.actorIds.length ? 'passed' : 'pending';
  }
  if (approvals > 0) return 'passed';
  return rejections === node.actorIds.length ? 'rejected' : 'pending';
}

function currentPendingActorIds(instance: ApprovalInstance): readonly string[] {
  const node = currentApprovalNode(instance);
  if (instance.status !== 'running' || node === null || node.type !== 'approval') return [];
  const decided = new Set(node.decisions.map((decision) => decision.principalApproverId));
  return node.actorIds.filter((actorId) => !decided.has(actorId));
}

function actionRecordDetails(action: ApprovalAction): Record<string, unknown> {
  switch (action.type) {
    case 'instance.decided':
      return {
        principalApproverId: action.principalApproverId,
        nodeId: action.nodeId,
        outcome: action.outcome,
        resultingStatus: action.resultingStatus,
        delegated: action.delegated,
      };
    case 'instance.approver_transferred':
      return {
        nodeId: action.nodeId,
        fromApproverId: action.fromApproverId,
        toApproverId: action.toApproverId,
      };
    case 'instance.approver_added':
      return { nodeId: action.nodeId, addedApproverId: action.approverId };
    case 'instance.submitted':
      return {};
    case 'instance.withdrawn':
      return { canceledApproverIds: [...action.canceledApproverIds] };
    case 'instance.archived':
      return {};
  }
}

function protectedData(record: ApprovalInstanceRecord): ProtectedApprovalFormData {
  return {
    formDataKeyId: record.formDataKeyId,
    formDataIv: record.formDataIv,
    formDataCiphertext: record.formDataCiphertext,
    formDataAuthTag: record.formDataAuthTag,
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw integrityError();
  }
}

function integrityError(): ApprovalDomainError {
  return new ApprovalDomainError('APPROVAL_PERSISTENCE_INTEGRITY_INVALID', '审批持久化数据完整性校验失败');
}

function toDate(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

function toIso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function isPlainObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
