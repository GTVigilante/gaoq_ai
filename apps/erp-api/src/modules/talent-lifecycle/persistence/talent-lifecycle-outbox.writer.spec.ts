import type { ClientSession, Model } from 'mongoose';
import type * as SharedUtils from '@gaoq/shared-utils';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { OutboxDocument } from '../../org/persistence/outbox.schema.js';
import type { TalentTouchpoint } from '../domain/index.js';
import { TalentLifecycleOutboxWriter } from './talent-lifecycle-outbox.writer.js';

const sharedUtils = vi.hoisted(() => ({
  createEventId: vi.fn(),
}));
vi.mock('@gaoq/shared-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof SharedUtils>()),
  createEventId: sharedUtils.createEventId,
}));

const TENANT_ID = 'tenant-001';
const TOUCHPOINT_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y6';
const CANDIDATE_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y7';
const EVENT_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y8';
const CREATED_AT = '2025-01-02T01:00:00.000Z';
const UPDATED_AT = '2025-01-02T02:00:00.000Z';
const OCCURRED_AT = '2025-01-01T01:00:00.000Z';
const NEXT_ACTION_AT = '2025-01-03T01:00:00.000Z';

const trusted = {
  tenant: { tenantId: TENANT_ID, source: 'access_token' },
  actor: {
    actorType: 'service',
    actorId: 'talent-service',
    tenantId: TENANT_ID,
    roleCodes: [],
    scopes: [],
    departmentIds: [],
    traceId: 'trace-talent-001',
  },
};
const session = {
  inTransaction: vi.fn(() => true),
} as unknown as ClientSession;
const createdOpen: TalentTouchpoint = Object.freeze({
  id: TOUCHPOINT_ID,
  tenantId: TENANT_ID,
  candidateId: CANDIDATE_ID,
  kind: 'candidate_outreach',
  channel: 'email',
  direction: 'outbound',
  outcome: 'follow_up_required',
  ownerActorId: 'actor-001',
  occurredAt: OCCURRED_AT,
  nextActionAt: NEXT_ACTION_AT,
  status: 'open',
  note: '等待反馈',
  version: 1,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
});

interface StoredOutboxRow {
  readonly eventId: string;
  readonly tenantId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly eventType: string;
  readonly envelope: {
    readonly data: Readonly<Record<string, unknown>>;
    readonly [key: string]: unknown;
  };
  readonly status: string;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
}

type CreateOutbox = (
  rows: readonly StoredOutboxRow[],
  options: { readonly session: ClientSession },
) => Promise<unknown>;

function fixture(
  options: {
    readonly context?: unknown;
    readonly create?: Mock<CreateOutbox>;
  } = {},
) {
  const context = {
    getRequired: vi.fn(() => options.context ?? trusted),
  };
  const create = options.create ??
    vi.fn<CreateOutbox>((rows) => Promise.resolve(rows));
  const writer = new TalentLifecycleOutboxWriter(
    context as unknown as TenantContextService,
    { create } as unknown as Model<OutboxDocument>,
  );
  return { writer, context, create };
}

describe('TalentLifecycleOutboxWriter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sharedUtils.createEventId.mockReturnValue(EVENT_ID);
  });

  it.each([
    ['created', createdOpen, 'cn.gaoq.erp.talent.touchpoint.created.v1'],
    [
      'created',
      { ...createdOpen, nextActionAt: null, status: 'completed' },
      'cn.gaoq.erp.talent.touchpoint.created.v1',
    ],
    [
      'completed',
      {
        ...createdOpen,
        status: 'completed',
        version: 2,
        updatedAt: UPDATED_AT,
      },
      'cn.gaoq.erp.talent.touchpoint.completed.v1',
    ],
    [
      'cancelled',
      {
        ...createdOpen,
        status: 'cancelled',
        version: 2,
        updatedAt: UPDATED_AT,
      },
      'cn.gaoq.erp.talent.touchpoint.cancelled.v1',
    ],
  ] as const)('在活动事务内可靠发布 %s 事件', async (action, touchpoint, eventType) => {
    const store = fixture();

    await expect(store.writer.append(
      touchpoint,
      action,
      session,
    )).resolves.toBeUndefined();

    expect(sharedUtils.createEventId).toHaveBeenCalledWith(
      new Date(touchpoint.updatedAt),
    );
    expect(store.create).toHaveBeenCalledTimes(1);
    const [rows, options] = store.create.mock.calls[0]!;
    expect(options).toEqual({ session });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      eventId: EVENT_ID,
      tenantId: TENANT_ID,
      aggregateType: 'talent.touchpoint',
      aggregateId: TOUCHPOINT_ID,
      aggregateVersion: touchpoint.version,
      eventType,
      envelope: {
        specversion: '1.0',
        id: EVENT_ID,
        source: '//gaoq-erp/talent-lifecycle-module',
        type: eventType,
        subject:
          `tenant/${TENANT_ID}/talent/touchpoints/${TOUCHPOINT_ID}`,
        time: touchpoint.updatedAt,
        datacontenttype: 'application/json',
        tenantId: TENANT_ID,
        traceId: 'trace-talent-001',
        idempotencyKey:
          `${TENANT_ID}:${eventType}:${TOUCHPOINT_ID}:${touchpoint.version}`,
        schemaVersion: '1',
        data: {
          tenantId: TENANT_ID,
          aggregateId: TOUCHPOINT_ID,
          version: touchpoint.version,
          candidateId: CANDIDATE_ID,
          kind: 'candidate_outreach',
          channel: 'email',
          outcome: 'follow_up_required',
          status: touchpoint.status,
          occurredAt: OCCURRED_AT,
          nextActionAt: touchpoint.nextActionAt,
        },
      },
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date(touchpoint.updatedAt),
    });
    expect(rows[0]!.envelope.data).not.toHaveProperty('note');
    expect(rows[0]!.envelope.data).not.toHaveProperty('ownerActorId');
    expect(rows[0]!.envelope.data).not.toHaveProperty('direction');
  });

  it.each([
    ['kind', [
      'candidate_outreach',
      'interview_support',
      'offer_support',
      'onboarding_support',
      'employee_care',
      'offboarding_support',
      'alumni_engagement',
      'rehire_contact',
    ]],
    ['channel', ['email', 'phone', 'wechat', 'meeting', 'portal', 'internal']],
    ['direction', ['inbound', 'outbound', 'internal']],
    ['outcome', [
      'contacted',
      'no_response',
      'follow_up_required',
      'resolved',
      'declined',
      'joined',
      'departed',
      'consent_withdrawn',
    ]],
  ] as const)('逐项接受 %s 领域白名单', async (field, values) => {
    for (const value of values) {
      const store = fixture();
      await expect(store.writer.append(
        { ...createdOpen, [field]: value },
        'created',
        session,
      )).resolves.toBeUndefined();
    }
  });

  it.each([
    ['非法动作', createdOpen, 'deleted'],
    ['未知字段', { ...createdOpen, injected: true }, 'created'],
    ['非法触点 ULID', { ...createdOpen, id: 'touchpoint-001' }, 'created'],
    ['非法候选人 ULID', { ...createdOpen, candidateId: 'candidate-001' }, 'created'],
    ['非法租户', { ...createdOpen, tenantId: 'tenant/001' }, 'created'],
    ['非法负责人', { ...createdOpen, ownerActorId: 'actor/001' }, 'created'],
    ['非法类型', { ...createdOpen, kind: 'unknown' }, 'created'],
    ['非法渠道', { ...createdOpen, channel: 'sms' }, 'created'],
    ['非法方向', { ...createdOpen, direction: 'external' }, 'created'],
    ['非法结果', { ...createdOpen, outcome: 'unknown' }, 'created'],
    ['非规范发生时间', { ...createdOpen, occurredAt: '2025-01-01' }, 'created'],
    ['非规范行动时间', { ...createdOpen, nextActionAt: '2025-01-03' }, 'created'],
    ['行动时间不晚于发生时间', {
      ...createdOpen,
      nextActionAt: OCCURRED_AT,
    }, 'created'],
    ['非法状态', { ...createdOpen, status: 'draft' }, 'created'],
    ['空备注', { ...createdOpen, note: '' }, 'created'],
    ['未规范备注', { ...createdOpen, note: ' 等待反馈 ' }, 'created'],
    ['过长备注', { ...createdOpen, note: '甲'.repeat(1_001) }, 'created'],
    ['零版本', { ...createdOpen, version: 0 }, 'created'],
    ['非整数版本', { ...createdOpen, version: 1.5 }, 'created'],
    ['非规范创建时间', { ...createdOpen, createdAt: '2025-01-02' }, 'created'],
    ['未来创建时间', {
      ...createdOpen,
      createdAt: '2999-01-02T01:00:00.000Z',
      updatedAt: '2999-01-02T01:00:00.000Z',
    }, 'created'],
    ['更新时间早于创建时间', {
      ...createdOpen,
      createdAt: UPDATED_AT,
      updatedAt: CREATED_AT,
    }, 'created'],
    ['创建动作版本不为一', { ...createdOpen, version: 2 }, 'created'],
    ['创建动作时间不一致', { ...createdOpen, updatedAt: UPDATED_AT }, 'created'],
    ['创建开放状态缺少行动时间', {
      ...createdOpen,
      nextActionAt: null,
    }, 'created'],
    ['创建完成状态仍有行动时间', {
      ...createdOpen,
      status: 'completed',
    }, 'created'],
    ['关闭动作状态不匹配', {
      ...createdOpen,
      status: 'cancelled',
      version: 2,
      updatedAt: UPDATED_AT,
    }, 'completed'],
    ['关闭动作版本不为二', {
      ...createdOpen,
      status: 'completed',
      updatedAt: UPDATED_AT,
    }, 'completed'],
    ['关闭动作缺少既有行动时间', {
      ...createdOpen,
      status: 'completed',
      version: 2,
      nextActionAt: null,
      updatedAt: UPDATED_AT,
    }, 'completed'],
  ])('拒绝%s并且不落库', async (_name, touchpoint, action) => {
    const store = fixture();

    await expect(store.writer.append(
      touchpoint as TalentTouchpoint,
      action as never,
      session,
    )).rejects.toThrow(
      action === 'deleted'
        ? 'TALENT_LIFECYCLE_OUTBOX_ACTION_INVALID'
        : 'TALENT_LIFECYCLE_OUTBOX_TOUCHPOINT_INVALID',
    );
    expect(store.create).not.toHaveBeenCalled();
  });

  it.each([
    ['上下文读取异常', undefined],
    ['外层未知字段', { ...trusted, attacker: true }],
    ['租户标识非法', {
      ...trusted,
      tenant: { ...trusted.tenant, tenantId: 'tenant/001' },
    }],
    ['主体租户不一致', {
      ...trusted,
      actor: { ...trusted.actor, tenantId: 'tenant-002' },
    }],
    ['追踪标识非法', {
      ...trusted,
      actor: { ...trusted.actor, traceId: 'trace/001' },
    }],
  ])('拒绝%s可信上下文', async (name, context) => {
    const store = fixture({ context });
    if (name === '上下文读取异常') {
      store.context.getRequired.mockImplementation(() => {
        throw new Error('MISSING_CONTEXT');
      });
    }

    await expect(store.writer.append(createdOpen, 'created', session))
      .rejects.toThrow('TALENT_LIFECYCLE_OUTBOX_CONTEXT_INVALID');
    expect(store.create).not.toHaveBeenCalled();
  });

  it('拒绝触点租户与可信租户不一致', async () => {
    const store = fixture();

    await expect(store.writer.append(
      { ...createdOpen, tenantId: 'tenant-002' },
      'created',
      session,
    )).rejects.toThrow('TALENT_LIFECYCLE_OUTBOX_TENANT_MISMATCH');
    expect(store.create).not.toHaveBeenCalled();
  });

  it.each([
    ['空会话', null],
    ['缺少事务方法', {}],
    ['事务未开启', { inTransaction: () => false }],
    ['事务状态异常', {
      inTransaction: () => {
        throw new Error('SESSION_FAILURE');
      },
    }],
  ])('拒绝%s', async (_name, invalidSession) => {
    const store = fixture();

    await expect(store.writer.append(
      createdOpen,
      'created',
      invalidSession as ClientSession,
    )).rejects.toThrow('TALENT_LIFECYCLE_OUTBOX_TRANSACTION_REQUIRED');
    expect(store.create).not.toHaveBeenCalled();
  });

  it('拒绝事件标识生成器返回非 ULID', async () => {
    const store = fixture();
    sharedUtils.createEventId.mockReturnValue('not-an-ulid');

    await expect(store.writer.append(createdOpen, 'created', session))
      .rejects.toThrow('TALENT_LIFECYCLE_OUTBOX_EVENT_ID_INVALID');
    expect(store.create).not.toHaveBeenCalled();
  });

  it.each([
    ['空结果', vi.fn<CreateOutbox>(() => Promise.resolve([]))],
    ['多结果', vi.fn<CreateOutbox>((rows) =>
      Promise.resolve([rows[0], rows[0]]))],
    ['事件标识被替换', vi.fn<CreateOutbox>((rows) => Promise.resolve([
      { ...rows[0], eventId: '01J8ZQK7V0A2M4N6P8R0T2W4Y9' },
    ]))],
    ['事件信封被替换', vi.fn<CreateOutbox>((rows) => Promise.resolve([
      { ...rows[0], envelope: { attacker: true } },
    ]))],
    ['重试状态被替换', vi.fn<CreateOutbox>((rows) => Promise.resolve([
      { ...rows[0], attempts: 1 },
    ]))],
    ['重试时间被替换', vi.fn<CreateOutbox>((rows) => Promise.resolve([
      { ...rows[0], nextAttemptAt: new Date(UPDATED_AT) },
    ]))],
  ] as const)('拒绝持久化%s', async (_name, create) => {
    const store = fixture({ create });

    await expect(store.writer.append(createdOpen, 'created', session))
      .rejects.toThrow('TALENT_LIFECYCLE_OUTBOX_WRITE_UNAVAILABLE');
  });

  it('保留数据库原始异常供事务协调器回滚', async () => {
    const databaseError = new Error('DATABASE_UNAVAILABLE');
    const store = fixture({
      create: vi.fn<CreateOutbox>(() => Promise.reject(databaseError)),
    });

    await expect(store.writer.append(createdOpen, 'created', session))
      .rejects.toBe(databaseError);
  });

  it('落库信封与调用方对象相互隔离', async () => {
    const mutable = { ...createdOpen } as {
      -readonly [Key in keyof TalentTouchpoint]: TalentTouchpoint[Key];
    };
    const store = fixture();

    await store.writer.append(mutable, 'created', session);
    mutable.outcome = 'declined';
    mutable.note = '篡改';

    const rows = store.create.mock.calls[0]![0];
    expect(rows[0]!.envelope.data['outcome']).toBe('follow_up_required');
    expect(rows[0]!.envelope.data).not.toHaveProperty('note');
  });
});
