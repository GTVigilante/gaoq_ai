import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { ApprovalDomainEvent } from '../domain/approval-events.js';
import { ApprovalOutboxWriter } from './approval-outbox.writer.js';

const TENANT_ID = 'tenant-001';
const AGGREGATE_ID = 'approval-001';
const OCCURRED_AT = '2026-07-22T10:00:00.000Z';
const HASH = 'h'.repeat(43);
const tenant = { tenantId: TENANT_ID, source: 'access_token' as const };
const actor: ActorContext = {
  actorType: 'service',
  actorId: 'approval-service',
  tenantId: TENANT_ID,
  roleCodes: [],
  scopes: [],
  departmentIds: [],
  traceId: 'trace-approval-001',
};
const session = { id: 'session-001' } as unknown as ClientSession;
const base = {
  tenantId: TENANT_ID,
  aggregateId: AGGREGATE_ID,
  version: 2,
  occurredAt: OCCURRED_AT,
} as const;

const validEvents: readonly {
  readonly event: ApprovalDomainEvent;
  readonly aggregateType: string;
}[] = [
  {
    event: {
      ...base,
      type: 'approval_template.draft_created',
      payload: {
        code: 'leave_request',
        revision: 1,
        riskLevel: 'R1',
        definitionHash: HASH,
      },
    },
    aggregateType: 'approval.template',
  },
  {
    event: {
      ...base,
      type: 'approval_template.published',
      payload: {
        code: 'leave_request',
        revision: 1,
        riskLevel: 'R2',
        definitionHash: HASH,
        approvedBy: 'approver-001',
      },
    },
    aggregateType: 'approval.template',
  },
  {
    event: {
      ...base,
      type: 'approval_template.retired',
      payload: { code: 'leave_request', revision: 1 },
    },
    aggregateType: 'approval.template',
  },
  {
    event: {
      ...base,
      type: 'approval_template.migrated',
      payload: {
        code: 'leave_request',
        revision: 1,
        status: 'retired',
        riskLevel: 'R2',
        definitionHash: HASH,
      },
    },
    aggregateType: 'approval.template',
  },
  {
    event: {
      ...base,
      type: 'approval_history.migrated',
      payload: {
        templateCode: 'leave_request',
        templateRevision: 1,
        outcome: 'approved',
        evidenceChecksum: HASH,
      },
    },
    aggregateType: 'approval.history',
  },
  {
    event: {
      ...base,
      type: 'approval_instance.draft_created',
      payload: {
        initiatorId: 'employee-001',
        templateCode: 'leave_request',
        templateRevision: 1,
        riskLevel: 'R1',
        formDataHash: HASH,
      },
    },
    aggregateType: 'approval.instance',
  },
  {
    event: {
      ...base,
      type: 'approval_instance.migrated',
      payload: {
        status: 'running',
        templateCode: 'leave_request',
        templateRevision: 1,
        riskLevel: 'R1',
        formDataHash: HASH,
        actionCount: 2,
        evidenceChecksum: HASH,
      },
    },
    aggregateType: 'approval.instance',
  },
  {
    event: {
      ...base,
      type: 'approval_instance.submitted',
      payload: { actorId: 'employee-001' },
    },
    aggregateType: 'approval.instance',
  },
  {
    event: {
      ...base,
      type: 'approval_instance.decided',
      payload: {
        actorId: 'delegate-001',
        principalApproverId: 'approver-001',
        delegated: true,
        nodeId: 'node-001',
        outcome: 'approved',
        resultingStatus: 'running',
      },
    },
    aggregateType: 'approval.instance',
  },
  {
    event: {
      ...base,
      type: 'approval_instance.approver_transferred',
      payload: {
        actorId: 'approver-001',
        nodeId: 'node-001',
        fromApproverId: 'approver-001',
        toApproverId: 'approver-002',
      },
    },
    aggregateType: 'approval.instance',
  },
  {
    event: {
      ...base,
      type: 'approval_instance.approver_added',
      payload: {
        actorId: 'approver-001',
        nodeId: 'node-001',
        approverId: 'approver-002',
      },
    },
    aggregateType: 'approval.instance',
  },
  {
    event: {
      ...base,
      type: 'approval_instance.withdrawn',
      payload: {
        actorId: 'employee-001',
        canceledApproverIds: ['approver-001', 'approver-002'],
      },
    },
    aggregateType: 'approval.instance',
  },
  {
    event: {
      ...base,
      type: 'approval_instance.archived',
      payload: { actorId: 'archivist-001' },
    },
    aggregateType: 'approval.instance',
  },
  {
    event: {
      ...base,
      type: 'approval_delegation.created',
      payload: {
        principalApproverId: 'approver-001',
        delegateId: 'delegate-001',
        validFrom: '2026-07-22T10:00:00.000Z',
        validUntil: '2026-08-01T10:00:00.000Z',
      },
    },
    aggregateType: 'approval.delegation',
  },
  {
    event: {
      ...base,
      type: 'approval_delegation.revoked',
      payload: {
        principalApproverId: 'approver-001',
        delegateId: 'delegate-001',
        revokedBy: 'approver-001',
      },
    },
    aggregateType: 'approval.delegation',
  },
];

function setup(): {
  readonly context: TenantContextService;
  readonly create: ReturnType<typeof vi.fn>;
  readonly writer: ApprovalOutboxWriter;
} {
  const context = new TenantContextService();
  const create = vi.fn().mockResolvedValue([]);
  return {
    context,
    create,
    writer: new ApprovalOutboxWriter(context, { create } as never),
  };
}

async function append(
  context: TenantContextService,
  writer: ApprovalOutboxWriter,
  event: unknown,
) {
  return context.run(
    { tenant, actor },
    () => writer.append(event as ApprovalDomainEvent, session),
  );
}

describe('ApprovalOutboxWriter', () => {
  it.each(validEvents)(
    '将 $event.type 收敛为严格 CloudEvent',
    async ({ event, aggregateType }) => {
      const { context, create, writer } = setup();

      const envelope = await append(context, writer, event);

      expect(create).toHaveBeenCalledOnce();
      const [documents, options] = create.mock.calls[0] as [
        readonly Record<string, unknown>[],
        { readonly session: ClientSession },
      ];
      const record = documents[0] as {
        readonly eventId: string;
        readonly tenantId: string;
        readonly aggregateType: string;
        readonly aggregateId: string;
        readonly aggregateVersion: number;
        readonly eventType: string;
        readonly envelope: Record<string, unknown>;
        readonly status: string;
        readonly attempts: number;
        readonly nextAttemptAt: Date;
      };
      expect(options.session).toBe(session);
      expect(record.eventId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
      expect(record).toMatchObject({
        tenantId: TENANT_ID,
        aggregateType,
        aggregateId: AGGREGATE_ID,
        aggregateVersion: 2,
        eventType: `cn.gaoq.erp.${event.type}.v1`,
        status: 'pending',
        attempts: 0,
      });
      expect(record.nextAttemptAt.toISOString()).toBe(OCCURRED_AT);
      expect(record.envelope).toEqual(envelope);
      expect(envelope).toMatchObject({
        specversion: '1.0',
        source: '//gaoq-erp/approval-module',
        type: `cn.gaoq.erp.${event.type}.v1`,
        subject: `tenant/${TENANT_ID}/${aggregateType}/${AGGREGATE_ID}`,
        time: OCCURRED_AT,
        datacontenttype: 'application/json',
        tenantId: TENANT_ID,
        traceId: actor.traceId,
        idempotencyKey:
          `${TENANT_ID}:cn.gaoq.erp.${event.type}.v1:${AGGREGATE_ID}:2`,
        schemaVersion: '1',
        data: {
          ...event.payload,
          tenantId: TENANT_ID,
          aggregateId: AGGREGATE_ID,
          version: 2,
        },
      });
      expect(JSON.stringify(record)).not.toMatch(
        /"formData"|"title"|"comment"|token|secret|password|credential|authorization/u,
      );
    },
  );

  it('拒绝跨租户事件且不写 Outbox', async () => {
    const { context, create, writer } = setup();
    const event = {
      ...validEvents[0]?.event,
      tenantId: 'tenant-002',
    };

    await expect(append(context, writer, event)).rejects.toThrow(
      'APPROVAL_OUTBOX_TENANT_MISMATCH',
    );
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ['未知事件类型', { ...base, type: 'approval_instance.deleted', payload: {} }],
    ['事件未知字段', { ...validEvents[0]?.event, actorId: 'attacker-001' }],
    ['非法租户', { ...validEvents[0]?.event, tenantId: '../tenant' }],
    ['非法聚合标识', { ...validEvents[0]?.event, aggregateId: 'approval/001' }],
    ['零版本', { ...validEvents[0]?.event, version: 0 }],
    ['非整数版本', { ...validEvents[0]?.event, version: 1.5 }],
    ['超安全整数版本', { ...validEvents[0]?.event, version: Number.MAX_SAFE_INTEGER + 1 }],
    ['非规范时间', { ...validEvents[0]?.event, occurredAt: '2026-07-22T10:00:00Z' }],
    ['无效日历时间', { ...validEvents[0]?.event, occurredAt: '2026-02-30T10:00:00.000Z' }],
    ['未来时间', { ...validEvents[0]?.event, occurredAt: '2999-01-01T00:00:00.000Z' }],
    ['空载荷', { ...validEvents[0]?.event, payload: null }],
  ])('拒绝%s', async (_label, event) => {
    const { context, create, writer } = setup();

    await expect(append(context, writer, event)).rejects.toThrow(
      'APPROVAL_OUTBOX_EVENT_INVALID',
    );
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    [
      '模板事件保留字段覆盖',
      validEvents[0]?.event,
      {
        code: 'leave_request',
        revision: 1,
        riskLevel: 'R1',
        definitionHash: HASH,
        tenantId: 'tenant-002',
      },
    ],
    [
      '模板发布缺少规范审批人',
      validEvents[1]?.event,
      {
        code: 'leave_request',
        revision: 1,
        riskLevel: 'R2',
        definitionHash: HASH,
        approvedBy: '../approver',
      },
    ],
    [
      '模板退役修订号非法',
      validEvents[2]?.event,
      { code: 'leave_request', revision: 0 },
    ],
    [
      '模板迁移状态非法',
      validEvents[3]?.event,
      {
        code: 'leave_request',
        revision: 1,
        status: 'deleted',
        riskLevel: 'R2',
        definitionHash: HASH,
      },
    ],
    [
      '历史迁移摘要非法',
      validEvents[4]?.event,
      {
        templateCode: 'leave_request',
        templateRevision: 1,
        outcome: 'approved',
        evidenceChecksum: 'invalid',
      },
    ],
    [
      '草稿事件夹带表单正文',
      validEvents[5]?.event,
      {
        ...(validEvents[5]?.event.payload ?? {}),
        formData: { salary: 100 },
      },
    ],
    [
      '运行中迁移动作数为零',
      validEvents[6]?.event,
      {
        ...(validEvents[6]?.event.payload ?? {}),
        actionCount: 0,
      },
    ],
    [
      '提交事件夹带表单摘要外字段',
      validEvents[7]?.event,
      { actorId: 'employee-001', formDataHash: HASH },
    ],
    [
      '拒绝决策与终态冲突',
      validEvents[8]?.event,
      {
        ...(validEvents[8]?.event.payload ?? {}),
        outcome: 'rejected',
        resultingStatus: 'approved',
      },
    ],
    [
      '批准决策伪装为拒绝终态',
      validEvents[8]?.event,
      {
        ...(validEvents[8]?.event.payload ?? {}),
        outcome: 'approved',
        resultingStatus: 'rejected',
      },
    ],
    [
      '代理标记与执行主体冲突',
      validEvents[8]?.event,
      {
        ...(validEvents[8]?.event.payload ?? {}),
        delegated: false,
      },
    ],
    [
      '转交来源与目标相同',
      validEvents[9]?.event,
      {
        actorId: 'approver-001',
        nodeId: 'node-001',
        fromApproverId: 'approver-001',
        toApproverId: 'approver-001',
      },
    ],
    [
      '加签主体非法',
      validEvents[10]?.event,
      {
        actorId: 'approver-001',
        nodeId: 'node-001',
        approverId: '../approver',
      },
    ],
    [
      '撤回取消列表重复',
      validEvents[11]?.event,
      {
        actorId: 'employee-001',
        canceledApproverIds: ['approver-001', 'approver-001'],
      },
    ],
    [
      '归档事件夹带审批正文',
      validEvents[12]?.event,
      { actorId: 'archivist-001', comment: 'sensitive' },
    ],
    [
      '委托人为本人代理',
      validEvents[13]?.event,
      {
        principalApproverId: 'approver-001',
        delegateId: 'approver-001',
        validFrom: '2026-07-22T10:00:00.000Z',
        validUntil: '2026-08-01T10:00:00.000Z',
      },
    ],
    [
      '委托截止时间早于开始时间',
      validEvents[13]?.event,
      {
        principalApproverId: 'approver-001',
        delegateId: 'delegate-001',
        validFrom: '2026-08-01T10:00:00.000Z',
        validUntil: '2026-07-22T10:00:00.000Z',
      },
    ],
    [
      '委托超过三十天',
      validEvents[13]?.event,
      {
        principalApproverId: 'approver-001',
        delegateId: 'delegate-001',
        validFrom: '2026-07-22T10:00:00.000Z',
        validUntil: '2026-08-22T10:00:00.001Z',
      },
    ],
    [
      '撤销主体不是委托人',
      validEvents[14]?.event,
      {
        principalApproverId: 'approver-001',
        delegateId: 'delegate-001',
        revokedBy: 'manager-001',
      },
    ],
  ])('拒绝%s', async (_label, event, payload) => {
    const { context, create, writer } = setup();

    await expect(append(context, writer, { ...event, payload })).rejects.toThrow(
      'APPROVAL_OUTBOX_EVENT_INVALID',
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('草稿迁移只接受零动作，运行中迁移只接受正动作', async () => {
    const { context, create, writer } = setup();
    const running = validEvents[6]?.event;
    const draft = {
      ...running,
      payload: {
        ...(running?.payload ?? {}),
        status: 'draft',
        actionCount: 0,
      },
    };

    await expect(append(context, writer, draft)).resolves.toMatchObject({
      data: { status: 'draft', actionCount: 0 },
    });
    await expect(append(context, writer, {
      ...draft,
      payload: { ...draft.payload, actionCount: 1 },
    })).rejects.toThrow('APPROVAL_OUTBOX_EVENT_INVALID');
    expect(create).toHaveBeenCalledOnce();
  });

  it('从可变输入生成独立规范副本，不允许调用方事后改写记录', async () => {
    const { context, create, writer } = setup();
    const event = structuredClone(validEvents[7]?.event) as {
      payload: { actorId: string };
    };

    await append(context, writer, event);
    event.payload.actorId = 'attacker-001';

    const documents = create.mock.calls[0]?.[0] as {
      readonly envelope: { readonly data: { readonly actorId: string } };
    }[];
    expect(documents[0]?.envelope.data.actorId).toBe('employee-001');
  });

  it('持久化失败原样终止，不返回伪成功事件', async () => {
    const { context, create, writer } = setup();
    create.mockRejectedValueOnce(new Error('MONGO_WRITE_FAILED'));

    await expect(append(context, writer, validEvents[0]?.event)).rejects.toThrow(
      'MONGO_WRITE_FAILED',
    );
    expect(create).toHaveBeenCalledOnce();
  });
});
