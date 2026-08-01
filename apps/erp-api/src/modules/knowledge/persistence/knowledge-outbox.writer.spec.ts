import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession, Model } from 'mongoose';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { OutboxDocument } from '../../org/persistence/outbox.schema.js';
import type { KnowledgeDomainEvent } from '../domain/index.js';
import { KnowledgeOutboxWriter } from './knowledge-outbox.writer.js';

interface StoredOutboxRow {
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
const AGGREGATE_ID = 'knowledge-001';
const OCCURRED_AT = '2026-07-29T01:00:00.000Z';
const actor: ActorContext = {
  actorType: 'system_job',
  actorId: 'system:knowledge-exam',
  tenantId: TENANT_ID,
  roleCodes: [],
  scopes: [],
  departmentIds: [],
  traceId: 'trace-knowledge-001',
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
const examBase = {
  assignmentId: 'assignment-001',
  courseVersionId: 'course-version-001',
  attemptNumber: 2,
  questionMode: 'mixed',
} as const;

const validEvents: readonly KnowledgeDomainEvent[] = [
  courseEvent('knowledge.course.created', 'draft'),
  courseEvent('knowledge.course.published', 'published'),
  courseEvent('knowledge.course.retired', 'retired'),
  event('knowledge.assignment.created', {
    onboardingInstanceId: 'onboarding-001',
    courseVersionId: 'course-version-001',
    mandatory: true,
    status: 'assigned',
    progressBps: 0,
    passed: false,
  }),
  event('knowledge.assignment.progressed', {
    onboardingInstanceId: 'onboarding-001',
    courseVersionId: 'course-version-001',
    mandatory: true,
    status: 'in_progress',
    progressBps: 5_000,
    passed: false,
  }),
  event('knowledge.assignment.completed', {
    onboardingInstanceId: 'onboarding-001',
    courseVersionId: 'course-version-001',
    mandatory: true,
    status: 'completed',
    progressBps: 10_000,
    passed: true,
  }),
  examRunEvent('knowledge.exam.run.requested', 'starting', false),
  examRunEvent('knowledge.exam.run.started', 'in_progress', false),
  examRunEvent('knowledge.exam.run.submitted', 'submitted', false),
  examRunEvent('knowledge.exam.run.timed_out', 'submitted', true),
  examRunEvent('knowledge.exam.run.review_pending', 'pending_review', true),
  event('knowledge.exam.run.dead', {
    ...examBase,
    status: 'dead',
    timedOut: false,
    failureCode: 'KNOWLEDGE_GATEWAY_UNAVAILABLE',
  }),
  event('knowledge.exam.run.replayed', {
    ...examBase,
    status: 'pending_review',
    timedOut: true,
    reasonCode: 'GATEWAY_RECOVERED',
  }),
  {
    ...base,
    version: 1,
    type: 'knowledge.exam.graded',
    payload: {
      assignmentId: 'assignment-001',
      attemptNumber: 2,
      questionMode: 'mixed',
      gradingPolicyVersion: 'mixed-v1',
      passingRule: 'all_required_sections',
      manuallyReviewed: true,
      submissionReason: 'timeout',
      passed: true,
    },
  },
  {
    ...base,
    version: 1,
    type: 'knowledge.onboarding.attested',
    payload: {
      onboardingInstanceId: 'onboarding-001',
      assignmentCount: 3,
    },
  },
];

describe('KnowledgeOutboxWriter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(validEvents)('按逐类型白名单发布 $type', async (published) => {
    const { writer, create } = setup();

    const eventId = await writer.append(published, session);

    expect(eventId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
    expect(create).toHaveBeenCalledTimes(1);
    const [rows, options] = create.mock.calls[0]!;
    expect(options).toEqual({ session });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventId,
      tenantId: TENANT_ID,
      aggregateType: 'knowledge',
      aggregateId: AGGREGATE_ID,
      aggregateVersion: published.version,
      eventType: `cn.gaoq.erp.${published.type}.v1`,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date(OCCURRED_AT),
    });
    expect(rows[0]!.envelope).toMatchObject({
      specversion: '1.0',
      source: '//gaoq-erp/knowledge-module',
      type: `cn.gaoq.erp.${published.type}.v1`,
      subject: `tenant/${TENANT_ID}/knowledge/${AGGREGATE_ID}`,
      time: OCCURRED_AT,
      tenantId: TENANT_ID,
      traceId: actor.traceId,
      schemaVersion: '1',
      data: {
        tenantId: TENANT_ID,
        aggregateId: AGGREGATE_ID,
        version: published.version,
        ...published.payload,
      },
    });
    expect(rows[0]!.envelope.data).not.toHaveProperty('answer');
    expect(rows[0]!.envelope.data).not.toHaveProperty('standardAnswer');
  });

  it.each([
    [{ ...validEvents[0], unknown: true }],
    [{ ...validEvents[0], type: 'knowledge.course.deleted' }],
    [{ ...validEvents[0], tenantId: '../tenant' }],
    [{ ...validEvents[0], aggregateId: '' }],
    [{ ...validEvents[0], version: 0 }],
    [{ ...validEvents[0], occurredAt: '2026-07-29T01:00:00Z' }],
    [{ ...validEvents[0], payload: null }],
    [{
      ...validEvents[0],
      payload: { ...validEvents[0]!.payload, status: 'published' },
    }],
    [{
      ...validEvents[3],
      payload: { ...validEvents[3]!.payload, progressBps: 1 },
    }],
    [{
      ...validEvents[4],
      payload: { ...validEvents[4]!.payload, passed: true },
    }],
    [{
      ...validEvents[4],
      payload: { ...validEvents[4]!.payload, status: 'assigned' },
    }],
    [{
      ...validEvents[5],
      payload: { ...validEvents[5]!.payload, progressBps: 9_999 },
    }],
    [{
      ...validEvents[6],
      payload: { ...validEvents[6]!.payload, status: 'in_progress' },
    }],
    [{
      ...validEvents[9],
      payload: { ...validEvents[9]!.payload, timedOut: false },
    }],
    [{
      ...validEvents[10],
      payload: { ...validEvents[10]!.payload, questionMode: 'objective' },
    }],
    [{
      ...validEvents[11],
      payload: { ...examBase, status: 'dead', timedOut: false },
    }],
    [{
      ...validEvents[12],
      payload: {
        ...validEvents[12]!.payload,
        status: 'starting',
        timedOut: true,
      },
    }],
    [{
      ...validEvents[12],
      payload: { ...validEvents[12]!.payload, reasonCode: 'free text' },
    }],
    [{
      ...validEvents[12],
      payload: {
        ...validEvents[12]!.payload,
        questionMode: 'objective',
      },
    }],
    [{ ...validEvents[13], version: 2 }],
    [{
      ...validEvents[13],
      payload: { ...validEvents[13]!.payload, manuallyReviewed: false },
    }],
    [{
      ...validEvents[13],
      payload: { ...validEvents[13]!.payload, answer: 'sensitive-answer' },
    }],
    [{
      ...validEvents[14],
      payload: { ...validEvents[14]!.payload, assignmentCount: 0 },
    }],
    [{
      ...validEvents[14],
      payload: { ...validEvents[14]!.payload, token: 'upstream-token' },
    }],
  ])('拒绝伪造状态、越界版本或敏感负载 %#', async (candidate) => {
    const { writer, create } = setup();

    await expect(writer.append(candidate as KnowledgeDomainEvent, session))
      .rejects.toThrow('KNOWLEDGE_OUTBOX_EVENT_INVALID');
    expect(create).not.toHaveBeenCalled();
  });

  it('拒绝事件租户与可信租户不一致', async () => {
    const { writer, create } = setup();

    await expect(writer.append(
      { ...validEvents[0]!, tenantId: 'tenant-002' },
      session,
    )).rejects.toThrow('KNOWLEDGE_OUTBOX_TENANT_MISMATCH');
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
      'KNOWLEDGE_OUTBOX_CONTEXT_INVALID',
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
    )).rejects.toThrow('KNOWLEDGE_OUTBOX_TRANSACTION_REQUIRED');
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
      'KNOWLEDGE_OUTBOX_WRITE_UNAVAILABLE',
    );
  });

  it('拒绝被篡改的完整数据库回执', async () => {
    const { writer, create } = setup();
    create.mockImplementationOnce((rows) => Promise.resolve([{
      ...rows[0]!,
      envelope: { ...rows[0]!.envelope, traceId: 'trace-tampered' },
    }]));

    await expect(writer.append(validEvents[0]!, session)).rejects.toThrow(
      'KNOWLEDGE_OUTBOX_WRITE_UNAVAILABLE',
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
    } as KnowledgeDomainEvent;
    const { writer, create } = setup();
    create.mockImplementationOnce((rows) => {
      (mutable.payload as Record<string, unknown>)['answer'] = 'sensitive-answer';
      return Promise.resolve(rows);
    });

    await writer.append(mutable, session);

    expect(create.mock.calls[0]![0][0]!.envelope.data).not.toHaveProperty('answer');
  });
});

function setup(
  getRequired: () => unknown = () => trusted,
): {
  readonly writer: KnowledgeOutboxWriter;
  readonly create: Mock<CreateOutbox>;
} {
  const context = {
    getRequired: vi.fn(getRequired),
  } as unknown as TenantContextService;
  const create = vi.fn<CreateOutbox>((rows) => Promise.resolve(rows));
  const records = { create } as unknown as Model<OutboxDocument>;
  return {
    writer: new KnowledgeOutboxWriter(context, records),
    create,
  };
}

function event(
  type: KnowledgeDomainEvent['type'],
  payload: Readonly<Record<string, unknown>>,
): KnowledgeDomainEvent {
  return { ...base, type, payload };
}

function courseEvent(
  type:
    | 'knowledge.course.created'
    | 'knowledge.course.published'
    | 'knowledge.course.retired',
  status: 'draft' | 'published' | 'retired',
): KnowledgeDomainEvent {
  return event(type, {
    courseCode: 'SECURITY_101',
    revision: 2,
    status,
    audienceMode: 'employment_scope',
  });
}

function examRunEvent(
  type:
    | 'knowledge.exam.run.requested'
    | 'knowledge.exam.run.started'
    | 'knowledge.exam.run.submitted'
    | 'knowledge.exam.run.timed_out'
    | 'knowledge.exam.run.review_pending',
  status: 'starting' | 'in_progress' | 'submitted' | 'pending_review',
  timedOut: boolean,
): KnowledgeDomainEvent {
  return event(type, { ...examBase, status, timedOut });
}
