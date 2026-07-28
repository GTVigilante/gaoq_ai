import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession, Model } from 'mongoose';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { OutboxDocument } from '../../org/persistence/outbox.schema.js';
import type { OnboardingDomainEvent } from '../domain/index.js';
import { OnboardingOutboxWriter } from './onboarding-outbox.writer.js';

interface StoredOutboxRow {
  readonly eventId: string;
  readonly tenantId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly eventType: string;
  readonly envelope: {
    readonly traceId: string;
    readonly data: Readonly<Record<string, unknown>>;
    readonly [key: string]: unknown;
  };
  readonly status: string;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly [key: string]: unknown;
}

type CreateOutbox = (
  rows: readonly StoredOutboxRow[],
  options: { readonly session: ClientSession },
) => Promise<readonly StoredOutboxRow[]>;

const TENANT_ID = 'tenant-001';
const AGGREGATE_ID = 'onboarding-001';
const OCCURRED_AT = '2026-07-28T01:00:00.000Z';
const actor: ActorContext = {
  actorType: 'service',
  actorId: 'onboarding-service',
  tenantId: TENANT_ID,
  roleCodes: [],
  scopes: [],
  departmentIds: [],
  traceId: 'trace-onboarding-001',
};
const trusted = {
  tenant: { tenantId: TENANT_ID, source: 'access_token' as const },
  actor,
};
const session = {
  inTransaction: vi.fn(() => true),
} as unknown as ClientSession;
const base = {
  tenantId: TENANT_ID,
  aggregateId: AGGREGATE_ID,
  version: 2,
  occurredAt: OCCURRED_AT,
} as const;
const validEvents: readonly OnboardingDomainEvent[] = [
  event('onboarding.created', {
    offerId: 'offer-001',
    applicationId: 'application-001',
    candidateId: 'candidate-001',
    status: 'in_progress',
  }),
  event('onboarding.task_completed', {
    taskCode: 'identity_verified',
    status: 'in_progress',
  }),
  event('onboarding.task_completed', {
    taskCode: 'mandatory_training_completed',
    status: 'ready',
  }),
  event('onboarding.provisioning_started', { status: 'provisioning' }),
  event('onboarding.completed', {
    status: 'completed',
    employmentId: 'employment-001',
  }),
];

describe('OnboardingOutboxWriter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(validEvents)('按逐类型白名单发布 $type', async (published) => {
    const { writer, create } = setup();

    await writer.append(published, session);

    expect(create).toHaveBeenCalledTimes(1);
    const [rows, options] = create.mock.calls[0]!;
    expect(options).toEqual({ session });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.eventId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
    expect(rows[0]).toMatchObject({
      tenantId: TENANT_ID,
      aggregateType: 'onboarding.instance',
      aggregateId: AGGREGATE_ID,
      aggregateVersion: published.version,
      eventType: `cn.gaoq.erp.${published.type}.v1`,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date(OCCURRED_AT),
    });
    expect(rows[0]!.envelope).toMatchObject({
      specversion: '1.0',
      source: '//gaoq-erp/onboarding-module',
      type: `cn.gaoq.erp.${published.type}.v1`,
      subject: `tenant/${TENANT_ID}/onboarding/${AGGREGATE_ID}`,
      time: OCCURRED_AT,
      datacontenttype: 'application/json',
      tenantId: TENANT_ID,
      traceId: actor.traceId,
      idempotencyKey:
        `${TENANT_ID}:cn.gaoq.erp.${published.type}.v1:${AGGREGATE_ID}:2`,
      schemaVersion: '1',
      data: {
        ...published.payload,
        tenantId: TENANT_ID,
        aggregateId: AGGREGATE_ID,
        version: published.version,
      },
    });
    expect(JSON.stringify(rows[0])).not.toMatch(
      /token|secret|password|credential|authorization|acceptanceEvidenceId/u,
    );
  });

  it.each([
    [{ ...validEvents[0], unknown: true }],
    [{ ...validEvents[0], type: 'onboarding.deleted' }],
    [{ ...validEvents[0], tenantId: '../tenant' }],
    [{ ...validEvents[0], aggregateId: '' }],
    [{ ...validEvents[0], version: 0 }],
    [{ ...validEvents[0], version: 1.5 }],
    [{ ...validEvents[0], version: Number.MAX_SAFE_INTEGER + 1 }],
    [{ ...validEvents[0], occurredAt: '2026-07-28T01:00:00Z' }],
    [{ ...validEvents[0], occurredAt: '2999-01-01T00:00:00.000Z' }],
    [{ ...validEvents[0], payload: null }],
    [{
      ...validEvents[0],
      payload: { ...validEvents[0]!.payload, status: 'ready' },
    }],
    [{
      ...validEvents[0],
      payload: { ...validEvents[0]!.payload, signedEvidenceId: 'evidence-001' },
    }],
    [{
      ...validEvents[1],
      payload: { taskCode: 'unknown_task', status: 'in_progress' },
    }],
    [{
      ...validEvents[1],
      payload: { taskCode: 'identity_verified', status: 'completed' },
    }],
    [{
      ...validEvents[3],
      payload: { status: 'ready' },
    }],
    [{
      ...validEvents[4],
      payload: { status: 'completed', employmentId: '../employment' },
    }],
    [{
      ...validEvents[4],
      payload: {
        ...validEvents[4]!.payload,
        token: 'upstream-token',
      },
    }],
  ])('拒绝伪造状态、越界标识或敏感负载 %#', async (candidate) => {
    const { writer, create } = setup();

    await expect(writer.append(
      candidate as OnboardingDomainEvent,
      session,
    )).rejects.toThrow('ONBOARDING_OUTBOX_EVENT_INVALID');
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    'contract_archived',
    'identity_verified',
    'materials_verified',
    'org_assignment_verified',
    'mandatory_training_completed',
  ])('接受规范任务代码 %s', async (taskCode) => {
    const { writer, create } = setup();

    await expect(writer.append(event('onboarding.task_completed', {
      taskCode,
      status: 'in_progress',
    }), session)).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('拒绝事件租户与可信租户不一致', async () => {
    const { writer, create } = setup();

    await expect(writer.append(
      { ...validEvents[0]!, tenantId: 'tenant-002' },
      session,
    )).rejects.toThrow('ONBOARDING_OUTBOX_TENANT_MISMATCH');
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    [() => {
      throw new Error('缺少上下文');
    }],
    [() => ({ ...trusted, actor: { ...actor, tenantId: 'tenant-002' } })],
    [() => ({ ...trusted, actor: { ...actor, traceId: 'bad trace' } })],
    [() => ({ ...trusted, unknown: true })],
  ])('拒绝缺失、分裂或受污染的可信上下文 %#', async (getRequired) => {
    const { writer, create } = setup(getRequired);

    await expect(writer.append(validEvents[0]!, session)).rejects.toThrow(
      'ONBOARDING_OUTBOX_CONTEXT_INVALID',
    );
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    [null],
    [{}],
    [{ inTransaction: 'true' }],
    [{ inTransaction: () => false }],
    [{ inTransaction: () => {
      throw new Error('会话损坏');
    } }],
  ])('拒绝非活动事务会话 %#', async (candidate) => {
    const { writer, create } = setup();

    await expect(writer.append(
      validEvents[0]!,
      candidate as unknown as ClientSession,
    )).rejects.toThrow('ONBOARDING_OUTBOX_TRANSACTION_REQUIRED');
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    [[]],
    [[{}, {}]],
    [[{ eventId: 'wrong' }]],
  ])('拒绝无法反向绑定的数据库创建结果 %#', async (created) => {
    const { writer, create } = setup();
    create.mockResolvedValueOnce(created as unknown as readonly StoredOutboxRow[]);

    await expect(writer.append(validEvents[0]!, session)).rejects.toThrow(
      'ONBOARDING_OUTBOX_WRITE_UNAVAILABLE',
    );
  });

  it('拒绝被篡改的完整数据库回执', async () => {
    const { writer, create } = setup();
    create.mockImplementationOnce((rows) => Promise.resolve([{
      ...rows[0]!,
      envelope: { ...rows[0]!.envelope, traceId: 'trace-tampered' },
    }]));

    await expect(writer.append(validEvents[0]!, session)).rejects.toThrow(
      'ONBOARDING_OUTBOX_WRITE_UNAVAILABLE',
    );
  });

  it('保留数据库异常供事务上层分类', async () => {
    const { writer, create } = setup();
    const failure = new Error('mongo unavailable');
    create.mockRejectedValueOnce(failure);

    await expect(writer.append(validEvents[0]!, session)).rejects.toBe(failure);
  });

  it('使用规范化副本阻止调用方在写入期间篡改负载', async () => {
    const mutable = {
      ...validEvents[0]!,
      payload: { ...validEvents[0]!.payload },
    } as OnboardingDomainEvent;
    const { writer, create } = setup();
    create.mockImplementationOnce((rows) => {
      (mutable.payload as Record<string, unknown>)['token'] = 'upstream-token';
      return Promise.resolve(rows);
    });

    await writer.append(mutable, session);

    expect(create.mock.calls[0]![0][0]!.envelope.data).not.toHaveProperty('token');
  });
});

function setup(
  getRequired: () => unknown = () => trusted,
): {
  readonly writer: OnboardingOutboxWriter;
  readonly create: Mock<CreateOutbox>;
} {
  const context = {
    getRequired: vi.fn(getRequired),
  } as unknown as TenantContextService;
  const create = vi.fn<CreateOutbox>((rows) => Promise.resolve(rows));
  const records = { create } as unknown as Model<OutboxDocument>;
  return {
    writer: new OnboardingOutboxWriter(context, records),
    create,
  };
}

function event(
  type: OnboardingDomainEvent['type'],
  payload: Readonly<Record<string, unknown>>,
): OnboardingDomainEvent {
  return { ...base, type, payload };
}
