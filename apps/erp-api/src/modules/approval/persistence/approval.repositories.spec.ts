import { ConfigService } from '@nestjs/config';
import type { ClientSession, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../../config/environment.js';
import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  createApprovalInstanceDraft,
  submitApprovalInstance,
} from '../domain/instance.js';
import {
  createApprovalTemplateDraft,
  publishApprovalTemplate,
  type ApprovalTemplateDefinition,
} from '../domain/template.js';
import { ApprovalDataCryptoService } from './approval-data-crypto.service.js';
import {
  ApprovalActionRepository,
  ApprovalInstanceRepository,
  ApprovalTemplateRepository,
} from './approval.repositories.js';
import type {
  ApprovalActionDocument,
  ApprovalInstanceDocument,
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

function definition(): ApprovalTemplateDefinition {
  return {
    fields: [
      { key: 'amount', label: '金额', type: 'money_minor', required: true, sensitivity: 'L2' },
      { key: 'remark', label: '说明', type: 'text', required: true, sensitivity: 'L3' },
    ],
    nodes: [{
      id: 'manager', name: '经理会签', type: 'approval', approvalMode: 'all',
      resolver: { type: 'employees', employeeIds: ['manager-001', 'manager-002'] },
    }],
  };
}

function publishedTemplate() {
  const draft = createApprovalTemplateDraft({
    id: 'template-001', tenantId: 'tenant-001', code: 'EXPENSE', name: '费用审批',
    riskLevel: 'R2', definition: definition(), actorId: 'editor-001',
  }, NOW);
  return publishApprovalTemplate(draft, {
    tenantId: 'tenant-001', expectedVersion: 1, approverId: 'publisher-001',
  }, NOW);
}

function runningInstance() {
  const draft = createApprovalInstanceDraft({
    id: 'instance-001', tenantId: 'tenant-001', title: '客户现场费用',
    initiatorId: 'employee-001', template: publishedTemplate(),
    formData: { amount: 123_45, remark: '敏感业务说明' },
  }, NOW);
  return submitApprovalInstance(draft, {
    tenantId: 'tenant-001', expectedVersion: 1, actorId: 'employee-001',
    resolvedNodes: [{ nodeId: 'manager', actorIds: ['manager-001', 'manager-002'] }],
  }, NOW).instance;
}

describe('审批租户仓储', () => {
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
});
