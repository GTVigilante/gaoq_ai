import { ConfigService } from '@nestjs/config';
import type { ClientSession, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../../config/environment.js';
import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  createApprovalDelegation,
  revokeApprovalDelegation,
  type ApprovalDelegation,
} from '../domain/delegation.js';
import {
  createApprovalLegacyHistory,
  type ApprovalLegacyHistory,
} from '../domain/legacy-history.js';
import {
  archiveApprovalInstance,
  createApprovalInstanceDraft,
  decideApprovalInstance,
  submitApprovalInstance,
  withdrawApprovalInstance,
  type ApprovalAction,
  type ApprovalInstance,
} from '../domain/instance.js';
import {
  createApprovalTemplateDraft,
  publishApprovalTemplate,
  type ApprovalTemplateDefinition,
} from '../domain/template.js';
import { ApprovalDataCryptoService } from './approval-data-crypto.service.js';
import {
  ApprovalActionRepository,
  ApprovalDelegationRepository,
  ApprovalInstanceRepository,
  ApprovalLegacyHistoryRepository,
  ApprovalTemplateRepository,
  ApprovalWriteConflictError,
} from './approval.repositories.js';
import type {
  ApprovalActionDocument,
  ApprovalDelegationDocument,
  ApprovalInstanceDocument,
  ApprovalLegacyHistoryDocument,
  ApprovalTemplateDocument,
} from './approval.schemas.js';

const NOW = new Date('2026-07-21T00:00:00.000Z');
const SESSION = {} as ClientSession;

function context(tenantId = 'tenant-001'): TenantContextService {
  return {
    getTenantRequired: () => ({ tenantId }),
  } as unknown as TenantContextService;
}

function crypto(): ApprovalDataCryptoService {
  const key = Buffer.alloc(32, 7).toString('base64url');
  const config = new ConfigService<AppEnvironment, true>({
    APPROVAL_DATA_ENCRYPTION_KEYS: JSON.stringify({
      activeKeyId: 'approval-key-001',
      keys: [{ keyId: 'approval-key-001', keyBase64url: key, status: 'active' }],
    }),
  } as AppEnvironment);
  return new ApprovalDataCryptoService(config);
}

function definition(approvalMode: 'all' | 'any' = 'all'): ApprovalTemplateDefinition {
  return {
    fields: [
      { key: 'amount', label: '金额', type: 'money_minor', required: true, sensitivity: 'L2' },
      { key: 'remark', label: '说明', type: 'text', required: true, sensitivity: 'L3' },
    ],
    nodes: [{
      id: 'manager', name: '经理会签', type: 'approval', approvalMode,
      resolver: { type: 'employees', employeeIds: ['manager-001', 'manager-002'] },
    }],
  };
}

function publishedTemplate(approvalMode: 'all' | 'any' = 'all') {
  const draft = createApprovalTemplateDraft({
    id: 'template-001', tenantId: 'tenant-001', code: 'EXPENSE', name: '费用审批',
    riskLevel: 'R2', definition: definition(approvalMode), actorId: 'editor-001',
  }, NOW);
  return publishApprovalTemplate(draft, {
    tenantId: 'tenant-001', expectedVersion: 1, approverId: 'publisher-001',
  }, NOW);
}

function runningInstance(approvalMode: 'all' | 'any' = 'all') {
  const draft = createApprovalInstanceDraft({
    id: 'instance-001', tenantId: 'tenant-001', title: '客户现场费用',
    initiatorId: 'employee-001', template: publishedTemplate(approvalMode),
    formData: { amount: 123_45, remark: '敏感业务说明' },
  }, NOW);
  return submitApprovalInstance(draft, {
    tenantId: 'tenant-001', expectedVersion: 1, actorId: 'employee-001',
    resolvedNodes: [{ nodeId: 'manager', actorIds: ['manager-001', 'manager-002'] }],
  }, NOW).instance;
}

function delegation(): ApprovalDelegation {
  return createApprovalDelegation({
    id: 'delegation-001',
    tenantId: 'tenant-001',
    principalApproverId: 'manager-001',
    delegateId: 'manager-002',
    validFrom: NOW.toISOString(),
    validUntil: '2026-08-01T00:00:00.000Z',
    actorId: 'manager-001',
  }, NOW);
}

function legacyHistory(): ApprovalLegacyHistory {
  return createApprovalLegacyHistory({
    id: 'legacy-001',
    tenantId: 'tenant-001',
    templateId: 'template-001',
    templateCode: 'EXPENSE',
    templateRevision: 1,
    initiatorEmployeeId: 'employee-001',
    outcome: 'approved',
    completedAt: '2026-07-20T00:00:00.000Z',
    archivedAt: '2026-07-20T01:00:00.000Z',
    migrationEvidenceRef:
      'erp://data-migrations/runs/01K00000000000000000000000/attachments/approval-001',
    evidenceChecksum: 'A'.repeat(43),
  }, NOW);
}

async function storedInstance(instance: ApprovalInstance = runningInstance()):
Promise<Record<string, unknown>> {
  const create = vi.fn().mockResolvedValue([]);
  const repository = new ApprovalInstanceRepository(
    context(),
    { create } as unknown as Model<ApprovalInstanceDocument>,
    crypto(),
  );
  await repository.insert(instance, SESSION);
  return (create.mock.calls[0]?.[0] as Array<Record<string, unknown>>)[0] ?? {};
}

async function restoreStoredInstance(
  stored: Record<string, unknown>,
  dataCrypto: ApprovalDataCryptoService = crypto(),
): Promise<ApprovalInstance | null> {
  const repository = new ApprovalInstanceRepository(context(), {
    findOne: () => ({ lean: () => ({ exec: () => Promise.resolve(stored) }) }),
  } as unknown as Model<ApprovalInstanceDocument>, dataCrypto);
  return repository.findById('instance-001');
}

describe('审批租户仓储', () => {
  it('已发布模板目录固定租户、状态、排序和上限', async () => {
    const stored = {
      id: 'template-001', tenantId: 'tenant-001', code: 'EXPENSE', name: '费用审批',
      riskLevel: 'R2', revision: 1, status: 'published',
      definitionJson: JSON.stringify(definition()), definitionHash: publishedTemplate().definitionHash,
      approvedBy: 'publisher-001', publishedAt: NOW, retiredAt: null, version: 2,
      createdBy: 'editor-001', updatedBy: 'publisher-001', createdAt: NOW, updatedAt: NOW,
    };
    const exec = vi.fn().mockResolvedValue([stored]);
    const lean = vi.fn().mockReturnValue({ exec });
    const limit = vi.fn().mockReturnValue({ lean });
    const sort = vi.fn().mockReturnValue({ limit });
    const find = vi.fn().mockReturnValue({ sort });
    const repository = new ApprovalTemplateRepository(
      context(), { find } as unknown as Model<ApprovalTemplateDocument>,
    );
    const templates = await repository.findPublished();
    expect(find).toHaveBeenCalledWith({ tenantId: 'tenant-001', status: 'published' });
    expect(sort).toHaveBeenCalledWith({ code: 1 });
    expect(limit).toHaveBeenCalledWith(201);
    expect(templates).toEqual([expect.objectContaining({ code: 'EXPENSE', status: 'published' })]);
  });

  it('迁移按模板编码与修订号查询时强制可信租户', async () => {
    const findOne = vi.fn().mockReturnValue({
      lean: () => ({ exec: () => Promise.resolve(null) }),
    });
    const repository = new ApprovalTemplateRepository(
      context(), { findOne } as unknown as Model<ApprovalTemplateDocument>,
    );
    await expect(repository.findByCodeAndRevision('EXPENSE', 3)).resolves.toBeNull();
    expect(findOne).toHaveBeenCalledWith({
      tenantId: 'tenant-001', code: 'EXPENSE', revision: 3,
    });
  });

  it('时间线查询固定可信租户、聚合版本顺序与最大记录数', async () => {
    const exec = vi.fn().mockResolvedValue([{
      actionId: '01K00000000000000000000000', tenantId: 'tenant-001', instanceId: 'instance-001',
      aggregateVersion: 1, actionType: 'instance.submitted', actorId: 'actor-001',
      principalApproverId: null, nodeId: null, outcome: null, resultingStatus: null,
      delegated: false, fromApproverId: null, toApproverId: null, addedApproverId: null,
      canceledApproverIds: [], occurredAt: NOW,
    }]);
    const lean = vi.fn().mockReturnValue({ exec });
    const limit = vi.fn().mockReturnValue({ lean });
    const sort = vi.fn().mockReturnValue({ limit });
    const find = vi.fn().mockReturnValue({ sort });
    const repository = new ApprovalActionRepository(
      context(), { find } as unknown as Model<ApprovalActionDocument>,
    );
    const timeline = await repository.findTimeline('instance-001');
    expect(find).toHaveBeenCalledWith({ tenantId: 'tenant-001', instanceId: 'instance-001' });
    expect(sort).toHaveBeenCalledWith({ aggregateVersion: 1 });
    expect(limit).toHaveBeenCalledWith(501);
    expect(timeline).toEqual([expect.objectContaining({
      actionId: '01K00000000000000000000000', occurredAt: NOW.toISOString(),
    })]);
    expect(JSON.stringify(timeline)).not.toContain('tenant-001');
  });

  it('委托目录只按可信租户和当前主体双向查询并限制 200 条', async () => {
    const stored = {
      id: 'delegation-001', tenantId: 'tenant-001', principalApproverId: 'manager-001',
      delegateId: 'manager-002', validFrom: NOW, validUntil: new Date('2026-08-01T00:00:00.000Z'),
      status: 'active', version: 1, createdBy: 'manager-001', revokedBy: null,
      createdAt: NOW, updatedAt: NOW,
    };
    const exec = vi.fn().mockResolvedValue([stored]);
    const lean = vi.fn().mockReturnValue({ exec });
    const limit = vi.fn().mockReturnValue({ lean });
    const sort = vi.fn().mockReturnValue({ limit });
    const find = vi.fn().mockReturnValue({ sort });
    const repository = new ApprovalDelegationRepository(
      context(), { find } as unknown as Model<ApprovalDelegationDocument>,
    );
    const result = await repository.findMine('manager-001');
    expect(find).toHaveBeenCalledWith({
      tenantId: 'tenant-001',
      $or: [{ principalApproverId: 'manager-001' }, { delegateId: 'manager-001' }],
    });
    expect(sort).toHaveBeenCalledWith({ validUntil: -1, id: 1 });
    expect(limit).toHaveBeenCalledWith(201);
    expect(result).toEqual([expect.objectContaining({ id: 'delegation-001', version: 1 })]);
  });

  it('模板落库使用定义 JSON 且拒绝跨租户实体', async () => {
    const create = vi.fn().mockResolvedValue([]);
    const records = { create } as unknown as Model<ApprovalTemplateDocument>;
    const repository = new ApprovalTemplateRepository(context(), records);
    await repository.insert(publishedTemplate(), SESSION);
    const documents = create.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
    expect(documents[0]).toMatchObject({
      tenantId: 'tenant-001', code: 'EXPENSE', status: 'published', revision: 1,
    });
    expect(documents[0]?.definitionJson).toEqual(expect.any(String));
    expect(JSON.stringify(documents[0])).not.toContain('"definition":{');

    const foreign = { ...publishedTemplate(), tenantId: 'tenant-002' };
    await expect(repository.insert(foreign, SESSION)).rejects.toThrow('跨租户');
  });

  it('实例落库只有密文，待办索引只含尚未决策的当前审批人', async () => {
    const create = vi.fn().mockResolvedValue([]);
    const records = { create } as unknown as Model<ApprovalInstanceDocument>;
    const repository = new ApprovalInstanceRepository(context(), records, crypto());
    await repository.insert(runningInstance(), SESSION);
    const documents = create.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
    const stored = documents[0];
    expect(stored).toMatchObject({
      tenantId: 'tenant-001', status: 'running', currentActorIds: ['manager-001', 'manager-002'],
      formDataKeyId: 'approval-key-001',
    });
    expect(stored?.formData).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain('敏感业务说明');

    const findOne = vi.fn().mockReturnValue({
      lean: () => ({ exec: () => Promise.resolve(stored) }),
    });
    const reader = new ApprovalInstanceRepository(
      context(), { findOne } as unknown as Model<ApprovalInstanceDocument>, crypto(),
    );
    const restored = await reader.findById('instance-001');
    expect(restored).toMatchObject({
      id: 'instance-001', status: 'running', formData: { amount: 123_45, remark: '敏感业务说明' },
    });

    const tampered = { ...stored, currentActorIds: ['attacker-001'] };
    const tamperedReader = new ApprovalInstanceRepository(context(), {
      findOne: () => ({ lean: () => ({ exec: () => Promise.resolve(tampered) }) }),
    } as unknown as Model<ApprovalInstanceDocument>, crypto());
    await expect(tamperedReader.findById('instance-001')).rejects.toThrowError(
      expect.objectContaining({ code: 'APPROVAL_PERSISTENCE_INTEGRITY_INVALID' }),
    );
  });

  it('模板查询覆盖会话、排序、空结果和完整性复核', async () => {
    const template = publishedTemplate();
    const stored = {
      ...template,
      definitionJson: JSON.stringify(template.definition),
      publishedAt: NOW,
      retiredAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const session = vi.fn().mockReturnThis();
    const exec = vi.fn()
      .mockResolvedValueOnce(stored)
      .mockResolvedValueOnce(stored)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(stored)
      .mockResolvedValueOnce(stored)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    const lean = vi.fn().mockReturnValue({ exec });
    const sort = vi.fn().mockReturnValue({ session, lean });
    const findOne = vi.fn().mockReturnValue({ session, lean, sort });
    const repository = new ApprovalTemplateRepository(
      context(),
      { findOne } as unknown as Model<ApprovalTemplateDocument>,
    );

    await expect(repository.findById('template-001', SESSION)).resolves.toMatchObject({
      id: 'template-001',
    });
    await expect(repository.findPublishedByCode('EXPENSE', SESSION)).resolves.toMatchObject({
      status: 'published',
    });
    await expect(repository.findByCodeAndRevision('EXPENSE', 99, SESSION)).resolves.toBeNull();
    await expect(repository.findLatestByCode('EXPENSE', SESSION)).resolves.toMatchObject({
      revision: 1,
    });
    await expect(repository.findByCodeAndRevision('EXPENSE', 1, SESSION)).resolves.toMatchObject({
      revision: 1,
    });
    await expect(repository.findPublishedByCode('MISSING', SESSION)).resolves.toBeNull();
    await expect(repository.findLatestByCode('MISSING', SESSION)).resolves.toBeNull();
    await expect(repository.findById('missing', SESSION)).resolves.toBeNull();
    expect(session).toHaveBeenCalledWith(SESSION);
    expect(sort).toHaveBeenCalledWith({ revision: -1 });

    const corrupt = { ...stored, definitionHash: 'B'.repeat(43) };
    const corruptRepository = new ApprovalTemplateRepository(context(), {
      findOne: () => ({ lean: () => ({ exec: () => Promise.resolve(corrupt) }) }),
    } as unknown as Model<ApprovalTemplateDocument>);
    await expect(corruptRepository.findById('template-001')).rejects.toMatchObject({
      code: 'APPROVAL_PERSISTENCE_INTEGRITY_INVALID',
    });
  });

  it('模板和实例单项查询覆盖无会话的空值与恢复分支', async () => {
    const template = publishedTemplate();
    const storedTemplate = {
      ...template,
      definitionJson: JSON.stringify(template.definition),
      publishedAt: NOW,
      retiredAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const values = [null, storedTemplate, null, null];
    const findOne = vi.fn().mockImplementation(() => {
      const query = {
        sort: vi.fn(),
        lean: vi.fn(),
        exec: vi.fn(() => Promise.resolve(values.shift())),
      };
      query.sort.mockReturnValue(query);
      query.lean.mockReturnValue(query);
      return query;
    });
    const templates = new ApprovalTemplateRepository(
      context(),
      { findOne } as unknown as Model<ApprovalTemplateDocument>,
    );
    await expect(templates.findById('missing')).resolves.toBeNull();
    await expect(templates.findByCodeAndRevision('EXPENSE', 1)).resolves.toMatchObject({
      id: 'template-001',
    });
    await expect(templates.findPublishedByCode('missing')).resolves.toBeNull();
    await expect(templates.findLatestByCode('missing')).resolves.toBeNull();

    const instanceQuery = {
      session: vi.fn(),
      lean: vi.fn(),
      exec: vi.fn().mockResolvedValue(null),
    };
    instanceQuery.session.mockReturnValue(instanceQuery);
    instanceQuery.lean.mockReturnValue(instanceQuery);
    const instances = new ApprovalInstanceRepository(
      context(),
      { findOne: vi.fn().mockReturnValue(instanceQuery) } as unknown as Model<ApprovalInstanceDocument>,
      crypto(),
    );
    await expect(instances.findById('missing', SESSION)).resolves.toBeNull();
    expect(instanceQuery.session).toHaveBeenCalledWith(SESSION);
  });

  it('模板目录和替换执行规模、租户与乐观锁门禁', async () => {
    const overflow = Array.from({ length: 201 }, () => ({}));
    const find = vi.fn().mockReturnValue({
      sort: () => ({ limit: () => ({ lean: () => ({ exec: () => Promise.resolve(overflow) }) }) }),
    });
    const overflowRepository = new ApprovalTemplateRepository(
      context(),
      { find } as unknown as Model<ApprovalTemplateDocument>,
    );
    await expect(overflowRepository.findPublished()).rejects.toMatchObject({
      code: 'APPROVAL_PERSISTENCE_INTEGRITY_INVALID',
    });

    const updateOne = vi.fn()
      .mockResolvedValueOnce({ matchedCount: 1 })
      .mockResolvedValueOnce({ matchedCount: 0 });
    const repository = new ApprovalTemplateRepository(
      context(),
      { updateOne } as unknown as Model<ApprovalTemplateDocument>,
    );
    await expect(repository.replace(publishedTemplate(), 1, SESSION)).resolves.toBeUndefined();
    await expect(repository.replace(publishedTemplate(), 1, SESSION))
      .rejects.toBeInstanceOf(ApprovalWriteConflictError);
    await expect(repository.replace(
      { ...publishedTemplate(), tenantId: 'tenant-002' },
      1,
      SESSION,
    )).rejects.toThrow('跨租户');
  });

  it('旧审批历史仅按可信租户读取并保持不可变证据字段', async () => {
    const history = legacyHistory();
    const stored = {
      ...history,
      completedAt: new Date(history.completedAt),
      archivedAt: new Date(history.archivedAt ?? ''),
      createdAt: NOW,
      updatedAt: NOW,
    };
    const session = vi.fn().mockReturnThis();
    const exec = vi.fn()
      .mockResolvedValueOnce(stored)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(stored)
      .mockResolvedValueOnce(null);
    const lean = vi.fn().mockReturnValue({ exec });
    const findOne = vi.fn().mockReturnValue({ session, lean });
    const create = vi.fn().mockResolvedValue([]);
    const repository = new ApprovalLegacyHistoryRepository(
      context(),
      { findOne, create } as unknown as Model<ApprovalLegacyHistoryDocument>,
    );

    await expect(repository.findByEvidenceRef(
      history.migrationEvidenceRef,
      SESSION,
    )).resolves.toEqual(history);
    await expect(repository.findById('missing', SESSION)).resolves.toBeNull();
    await expect(repository.findById('legacy-001', SESSION)).resolves.toEqual(history);
    await expect(repository.findByEvidenceRef('missing', SESSION)).resolves.toBeNull();
    await expect(repository.insert(history, SESSION)).resolves.toBeUndefined();
    expect(findOne).toHaveBeenNthCalledWith(1, {
      tenantId: 'tenant-001',
      migrationEvidenceRef: history.migrationEvidenceRef,
    });
    expect(session).toHaveBeenCalledWith(SESSION);
    expect(create).toHaveBeenCalledWith([
      expect.objectContaining({
        tenantId: 'tenant-001',
        completedAt: new Date(history.completedAt),
      }),
    ], { session: SESSION });
    await expect(repository.insert(
      { ...history, tenantId: 'tenant-002' },
      SESSION,
    )).rejects.toThrow('跨租户');
  });

  it('实例列表固定可信租户、稳定排序和读取上限', async () => {
    const stored = await storedInstance();
    const exec = vi.fn().mockResolvedValue([stored]);
    const lean = vi.fn().mockReturnValue({ exec });
    const limit = vi.fn().mockReturnValue({ lean });
    const sort = vi.fn().mockReturnValue({ limit });
    const find = vi.fn().mockReturnValue({ sort });
    const repository = new ApprovalInstanceRepository(
      context(),
      { find } as unknown as Model<ApprovalInstanceDocument>,
      crypto(),
    );

    await expect(repository.findInbox('manager-001', 1_000)).resolves.toHaveLength(1);
    await expect(repository.findInitiated('employee-001', 0)).resolves.toHaveLength(1);
    expect(find).toHaveBeenNthCalledWith(1, {
      tenantId: 'tenant-001',
      status: 'running',
      currentActorIds: 'manager-001',
    });
    expect(find).toHaveBeenNthCalledWith(2, {
      tenantId: 'tenant-001',
      initiatorId: 'employee-001',
    });
    expect(limit).toHaveBeenNthCalledWith(1, 100);
    expect(limit).toHaveBeenNthCalledWith(2, 1);
  });

  it('实例替换执行可信租户和版本条件并拒绝冲突', async () => {
    const updateOne = vi.fn()
      .mockResolvedValueOnce({ matchedCount: 1 })
      .mockResolvedValueOnce({ matchedCount: 0 });
    const repository = new ApprovalInstanceRepository(
      context(),
      { updateOne } as unknown as Model<ApprovalInstanceDocument>,
      crypto(),
    );
    const instance = runningInstance();
    await expect(repository.replace(instance, 1, SESSION)).resolves.toBeUndefined();
    const [filter, update, options] = updateOne.mock.calls[0] as [
      Record<string, unknown>,
      { $set: Record<string, unknown> },
      Record<string, unknown>,
    ];
    expect(filter).toEqual({ tenantId: 'tenant-001', id: instance.id, version: 1 });
    expect(update.$set.status).toBe('running');
    expect(options).toEqual({ session: SESSION, timestamps: false });
    await expect(repository.replace(instance, 1, SESSION))
      .rejects.toBeInstanceOf(ApprovalWriteConflictError);
    await expect(repository.replace(
      { ...instance, tenantId: 'tenant-002' },
      1,
      SESSION,
    )).rejects.toThrow('跨租户');
  });

  it('实例恢复覆盖草稿、运行、通过、拒绝、撤回和归档状态', async () => {
    const draft = createApprovalInstanceDraft({
      id: 'instance-001',
      tenantId: 'tenant-001',
      title: '客户现场费用',
      initiatorId: 'employee-001',
      template: publishedTemplate(),
      formData: { amount: 123_45, remark: '敏感业务说明' },
    }, NOW);
    const running = runningInstance();
    const pending = decideApprovalInstance(running, {
      tenantId: 'tenant-001',
      expectedVersion: running.version,
      actorId: 'manager-001',
      principalApproverId: 'manager-001',
      delegationVerified: false,
      outcome: 'approved',
    }, new Date('2026-07-21T01:00:00.000Z')).instance;
    const approved = decideApprovalInstance(pending, {
      tenantId: 'tenant-001',
      expectedVersion: pending.version,
      actorId: 'manager-002',
      principalApproverId: 'manager-002',
      delegationVerified: false,
      outcome: 'approved',
    }, new Date('2026-07-21T02:00:00.000Z')).instance;
    const rejected = decideApprovalInstance(running, {
      tenantId: 'tenant-001',
      expectedVersion: running.version,
      actorId: 'manager-001',
      principalApproverId: 'manager-001',
      delegationVerified: false,
      outcome: 'rejected',
    }, new Date('2026-07-21T01:00:00.000Z')).instance;
    const withdrawn = withdrawApprovalInstance(running, {
      tenantId: 'tenant-001',
      expectedVersion: running.version,
      actorId: 'employee-001',
    }, new Date('2026-07-21T01:00:00.000Z')).instance;
    const archived = archiveApprovalInstance(rejected, {
      tenantId: 'tenant-001',
      expectedVersion: rejected.version,
      actorId: 'admin-001',
      authorizationVerified: true,
    }, new Date('2026-07-21T03:00:00.000Z')).instance;

    for (const instance of [draft, running, pending, approved, rejected, withdrawn, archived]) {
      const restored = await restoreStoredInstance(await storedInstance(instance));
      expect(restored?.status).toBe(instance.status);
      expect(restored?.currentNodeIndex).toBe(instance.currentNodeIndex);
    }
  });

  it('任一通过模式恢复待决、通过与全员拒绝状态', async () => {
    const running = runningInstance('any');
    const approved = decideApprovalInstance(running, {
      tenantId: 'tenant-001',
      expectedVersion: running.version,
      actorId: 'manager-001',
      principalApproverId: 'manager-001',
      delegationVerified: false,
      outcome: 'approved',
    }, new Date('2026-07-21T01:00:00.000Z')).instance;
    const pendingRejection = decideApprovalInstance(running, {
      tenantId: 'tenant-001',
      expectedVersion: running.version,
      actorId: 'manager-001',
      principalApproverId: 'manager-001',
      delegationVerified: false,
      outcome: 'rejected',
    }, new Date('2026-07-21T01:00:00.000Z')).instance;
    const rejected = decideApprovalInstance(pendingRejection, {
      tenantId: 'tenant-001',
      expectedVersion: pendingRejection.version,
      actorId: 'manager-002',
      principalApproverId: 'manager-002',
      delegationVerified: false,
      outcome: 'rejected',
    }, new Date('2026-07-21T02:00:00.000Z')).instance;

    for (const instance of [approved, pendingRejection, rejected]) {
      await expect(restoreStoredInstance(await storedInstance(instance))).resolves.toMatchObject({
        status: instance.status,
      });
    }
  });

  it('实例恢复拒绝快照、正文、节点和状态投影篡改', async () => {
    const running = await storedInstance();
    const draft = await storedInstance(createApprovalInstanceDraft({
      id: 'instance-001',
      tenantId: 'tenant-001',
      title: '客户现场费用',
      initiatorId: 'employee-001',
      template: publishedTemplate(),
      formData: { amount: 123_45, remark: '敏感业务说明' },
    }, NOW));
    const pending = decideApprovalInstance(runningInstance(), {
      tenantId: 'tenant-001',
      expectedVersion: 2,
      actorId: 'manager-001',
      principalApproverId: 'manager-001',
      delegationVerified: false,
      outcome: 'approved',
    }, new Date('2026-07-21T01:00:00.000Z')).instance;
    const pendingStored = await storedInstance(pending);
    const parsedNodes = JSON.parse(String(pendingStored.resolvedNodesJson)) as {
      nodes: Array<Record<string, unknown>>;
    };
    const parsedSnapshot = JSON.parse(String(running.templateSnapshotJson)) as Record<string, unknown>;
    const corruptions: ReadonlyArray<Record<string, unknown>> = [
      { ...running, templateId: 'template-002' },
      { ...running, formDataHash: 'B'.repeat(43) },
      { ...running, templateSnapshotJson: '{' },
      {
        ...running,
        templateSnapshotJson: JSON.stringify({
          ...parsedSnapshot,
          definitionHash: 'B'.repeat(43),
        }),
      },
      { ...running, resolvedNodesJson: '{' },
      { ...running, resolvedNodesJson: JSON.stringify({ nodes: [] }) },
      {
        ...running,
        resolvedNodesJson: JSON.stringify({
          nodes: [{ ...parsedNodes.nodes[0], id: 'other-node' }],
        }),
      },
      {
        ...running,
        resolvedNodesJson: JSON.stringify({
          nodes: [{
            ...parsedNodes.nodes[0],
            actorIds: ['manager-001', 'manager-001'],
            decisions: [],
          }],
        }),
      },
      {
        ...pendingStored,
        resolvedNodesJson: JSON.stringify({
          nodes: [{
            ...parsedNodes.nodes[0],
            decisions: [{
              principalApproverId: 'manager-003',
              decidedBy: 'manager-003',
              outcome: 'approved',
              decidedAt: '2026-07-21T01:00:00.000Z',
              delegated: false,
            }],
          }],
        }),
      },
      {
        ...pendingStored,
        resolvedNodesJson: JSON.stringify({
          nodes: [{
            ...parsedNodes.nodes[0],
            decisions: [
              ...(parsedNodes.nodes[0]?.decisions as Array<Record<string, unknown>>),
              ...(parsedNodes.nodes[0]?.decisions as Array<Record<string, unknown>>),
            ],
          }],
        }),
      },
      { ...draft, resolvedNodesJson: running.resolvedNodesJson },
      { ...running, status: 'approved', currentNodeIndex: null },
      { ...running, status: 'rejected', currentNodeIndex: null },
      { ...running, currentNodeIndex: 99 },
    ];

    for (const corrupted of corruptions) {
      await expect(restoreStoredInstance(corrupted)).rejects.toMatchObject({
        code: 'APPROVAL_PERSISTENCE_INTEGRITY_INVALID',
      });
    }

    const nonObjectCrypto = {
      unprotect: () => [],
    } as unknown as ApprovalDataCryptoService;
    await expect(restoreStoredInstance(running, nonObjectCrypto)).rejects.toMatchObject({
      code: 'APPROVAL_PERSISTENCE_INTEGRITY_INVALID',
    });

    const emptyRepository = new ApprovalInstanceRepository(context(), {
      findOne: () => ({
        session: vi.fn(),
        lean: () => ({ exec: () => Promise.resolve(null) }),
      }),
    } as unknown as Model<ApprovalInstanceDocument>, crypto());
    await expect(emptyRepository.findById('missing', SESSION)).resolves.toBeNull();
  });

  it('动作账本为所有动作类型生成最小投影且拒绝跨租户', async () => {
    const create = vi.fn().mockResolvedValue([]);
    const repository = new ApprovalActionRepository(
      context(),
      { create } as unknown as Model<ApprovalActionDocument>,
    );
    const instance = runningInstance();
    const base = { actorId: 'manager-001', occurredAt: NOW.toISOString() };
    const actions: readonly ApprovalAction[] = [
      { type: 'instance.submitted', ...base },
      {
        type: 'instance.decided',
        ...base,
        principalApproverId: 'manager-001',
        delegated: false,
        nodeId: 'manager',
        outcome: 'approved',
        resultingStatus: 'running',
      },
      {
        type: 'instance.approver_transferred',
        ...base,
        nodeId: 'manager',
        fromApproverId: 'manager-001',
        toApproverId: 'manager-003',
      },
      {
        type: 'instance.approver_added',
        ...base,
        nodeId: 'manager',
        approverId: 'manager-003',
      },
      { type: 'instance.withdrawn', ...base, canceledApproverIds: ['manager-001'] },
      { type: 'instance.archived', ...base },
    ];

    for (const action of actions) await repository.append(instance, action, SESSION);
    expect(create).toHaveBeenCalledTimes(actions.length);
    expect(create.mock.calls.map((call) =>
      (call[0] as Array<Record<string, unknown>>)[0]?.actionType,
    )).toEqual(actions.map((action) => action.type));
    expect(create.mock.calls[1]?.[0]).toEqual([
      expect.objectContaining({
        principalApproverId: 'manager-001',
        outcome: 'approved',
      }),
    ]);
    await expect(repository.append(
      { ...instance, tenantId: 'tenant-002' },
      actions[0] as ApprovalAction,
      SESSION,
    )).rejects.toThrow('跨租户');
  });

  it('动作时间线超过固定上限时按完整性故障失败关闭', async () => {
    const records = Array.from({ length: 501 }, () => ({}));
    const find = vi.fn().mockReturnValue({
      sort: () => ({ limit: () => ({ lean: () => ({ exec: () => Promise.resolve(records) }) }) }),
    });
    const repository = new ApprovalActionRepository(
      context(),
      { find } as unknown as Model<ApprovalActionDocument>,
    );
    await expect(repository.findTimeline('instance-001')).rejects.toMatchObject({
      code: 'APPROVAL_PERSISTENCE_INTEGRITY_INVALID',
    });
  });

  it('委托读取和重叠检查绑定可信租户及会话', async () => {
    const value = delegation();
    const stored = {
      ...value,
      validFrom: new Date(value.validFrom),
      validUntil: new Date(value.validUntil),
      createdAt: NOW,
      updatedAt: NOW,
    };
    const session = vi.fn().mockReturnThis();
    const exec = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(stored)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(null);
    const exists = vi.fn().mockReturnValue({ session, exec });
    const lean = vi.fn().mockReturnValue({ exec });
    const findOne = vi.fn().mockReturnValue({ session, lean });
    const repository = new ApprovalDelegationRepository(
      context(),
      { exists, findOne } as unknown as Model<ApprovalDelegationDocument>,
    );

    await expect(repository.isActive(
      'manager-001',
      'manager-002',
      NOW,
      SESSION,
    )).resolves.toBe(true);
    await expect(repository.isActive(
      'manager-001',
      'manager-003',
      NOW,
    )).resolves.toBe(false);
    await expect(repository.findById('delegation-001', SESSION)).resolves.toEqual(value);
    await expect(repository.hasOverlap(
      'manager-001',
      value.validFrom,
      value.validUntil,
      SESSION,
    )).resolves.toBe(true);
    await expect(repository.findById('missing', SESSION)).resolves.toBeNull();
    expect(exists).toHaveBeenNthCalledWith(1, expect.objectContaining({
      tenantId: 'tenant-001',
      status: 'active',
    }));
    expect(session).toHaveBeenCalledWith(SESSION);
  });

  it('委托写入、撤销替换和冲突均执行租户与版本门禁', async () => {
    const create = vi.fn().mockResolvedValue([]);
    const updateOne = vi.fn()
      .mockResolvedValueOnce({ matchedCount: 1 })
      .mockResolvedValueOnce({ matchedCount: 0 });
    const repository = new ApprovalDelegationRepository(
      context(),
      { create, updateOne } as unknown as Model<ApprovalDelegationDocument>,
    );
    const active = delegation();
    const revoked = revokeApprovalDelegation(active, {
      tenantId: 'tenant-001',
      expectedVersion: 1,
      actorId: 'manager-001',
    }, new Date('2026-07-22T00:00:00.000Z'));

    await expect(repository.insert(active, SESSION)).resolves.toBeUndefined();
    const [createdDocuments, createOptions] = create.mock.calls[0] as [
      Array<Record<string, unknown>>,
      Record<string, unknown>,
    ];
    expect(createdDocuments[0]?.tenantId).toBe('tenant-001');
    expect(createdDocuments[0]?.coverageDays).toEqual([
      '2026-07-21',
      '2026-07-22',
      '2026-07-23',
      '2026-07-24',
      '2026-07-25',
      '2026-07-26',
      '2026-07-27',
      '2026-07-28',
      '2026-07-29',
      '2026-07-30',
      '2026-07-31',
    ]);
    expect(createOptions).toEqual({ session: SESSION });
    await expect(repository.replace(revoked, 1, SESSION)).resolves.toBeUndefined();
    await expect(repository.replace(revoked, 1, SESSION))
      .rejects.toBeInstanceOf(ApprovalWriteConflictError);
    await expect(repository.insert(
      { ...active, tenantId: 'tenant-002' },
      SESSION,
    )).rejects.toThrow('跨租户');
  });

  it('委托目录超过固定上限时按完整性故障失败关闭', async () => {
    const records = Array.from({ length: 201 }, () => ({}));
    const find = vi.fn().mockReturnValue({
      sort: () => ({ limit: () => ({ lean: () => ({ exec: () => Promise.resolve(records) }) }) }),
    });
    const repository = new ApprovalDelegationRepository(
      context(),
      { find } as unknown as Model<ApprovalDelegationDocument>,
    );
    await expect(repository.findMine('manager-001')).rejects.toMatchObject({
      code: 'APPROVAL_PERSISTENCE_INTEGRITY_INVALID',
    });
  });
});
