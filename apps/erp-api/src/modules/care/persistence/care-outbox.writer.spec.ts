import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession, Model } from 'mongoose';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type {
  AlumniCleanupDomainEvent,
  AlumniConsentDomainEvent,
  CareDomainEvent,
  CareOccasionDomainEvent,
} from '../domain/index.js';
import type { OutboxDocument } from '../../org/persistence/outbox.schema.js';
import { CareOutboxWriter } from './care-outbox.writer.js';

type PublishedEvent =
  | CareDomainEvent
  | AlumniConsentDomainEvent
  | AlumniCleanupDomainEvent
  | CareOccasionDomainEvent;

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
const AGGREGATE_ID = 'care-001';
const OCCURRED_AT = '2026-07-22T10:00:00.000Z';
const actor: ActorContext = {
  actorType: 'service',
  actorId: 'care-service',
  tenantId: TENANT_ID,
  roleCodes: [],
  scopes: [],
  departmentIds: [],
  traceId: 'trace-care-001',
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
const careCasePayload = {
  employeeId: 'employee-001',
  employmentId: 'employment-001',
  separationType: 'voluntary_resignation',
  reasonCode: 'PERSONAL_REASON',
  lastWorkingDate: '2026-07-31',
  accessDisableAt: '2026-07-31T10:00:00.000Z',
} as const;
const consentPayload = {
  careCaseId: 'care-001',
  purpose: 'alumni_network',
  channels: ['email', 'wechat'],
  expiresAt: '2027-07-22T10:00:00.000Z',
} as const;
const cleanupPayload = {
  purpose: 'alumni_network',
  terminationReason: 'withdrawn',
  targetCode: 'crm',
  policyVersion: 'privacy-v1',
} as const;
const occasionPayload = {
  purpose: 'employee_care',
  occasionType: 'birthday',
  policyVersion: 'care-v1',
} as const;

const validEvents: readonly PublishedEvent[] = [
  careCaseEvent('care.case.created', 'draft'),
  careCaseEvent('care.case.approval_submitted', 'pending_approval'),
  careCaseEvent('care.case.approved', 'approved'),
  careCaseEvent('care.case.rejected', 'cancelled'),
  {
    ...base,
    type: 'care.case.task_completed',
    payload: { ...careCasePayload, status: 'ready', taskCode: 'finance_cleared' },
  },
  careCaseEvent('care.case.scheduled', 'scheduled'),
  careCaseEvent('care.case.execution_started', 'executing'),
  careCaseEvent('care.case.completed', 'completed'),
  consentEvent('care.alumni_consent.granted', 'active'),
  consentEvent('care.alumni_consent.withdrawn', 'withdrawn'),
  consentEvent('care.alumni_consent.expired', 'expired'),
  cleanupEvent('care.alumni_cleanup.scheduled', 'pending', 0),
  cleanupEvent('care.alumni_cleanup.completed', 'completed', 0),
  cleanupEvent('care.alumni_cleanup.dead', 'dead', 3),
  cleanupEvent('care.alumni_cleanup.replayed', 'pending', 0),
  {
    ...base,
    type: 'care.occasion.preference_updated',
    payload: {
      purpose: 'employee_care',
      birthdayEnabled: true,
      anniversaryEnabled: false,
      unsubscribed: false,
    },
  },
  {
    ...base,
    type: 'care.occasion.unsubscribed',
    payload: {
      purpose: 'employee_care',
      birthdayEnabled: false,
      anniversaryEnabled: false,
      unsubscribed: true,
    },
  },
  occasionEvent('care.occasion.scheduled', 'pending', 0),
  occasionEvent('care.occasion.delivered', 'delivered', 1),
  {
    ...base,
    type: 'care.occasion.cancelled',
    payload: {
      ...occasionPayload,
      status: 'cancelled',
      attempts: 0,
      denialCode: 'purpose_restricted',
    },
  },
  occasionEvent('care.occasion.dead', 'dead', 3),
  {
    ...base,
    type: 'care.occasion.replayed',
    payload: {
      ...occasionPayload,
      status: 'pending',
      attempts: 0,
      reasonCode: 'MANUAL_REPLAY',
    },
  },
];

describe('CareOutboxWriter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(validEvents)('按严格白名单发布 $type', async (event) => {
    const { writer, create } = setup();

    await writer.append(event, session);

    expect(create).toHaveBeenCalledTimes(1);
    const [rows, options] = create.mock.calls[0]!;
    expect(options).toEqual({ session });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: TENANT_ID,
      aggregateType: 'care',
      aggregateId: AGGREGATE_ID,
      aggregateVersion: 2,
      eventType: `cn.gaoq.erp.${event.type}.v1`,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date(OCCURRED_AT),
    });
    expect(rows[0]!.envelope).toMatchObject({
      specversion: '1.0',
      source: '//gaoq-erp/care-module',
      type: `cn.gaoq.erp.${event.type}.v1`,
      subject: `tenant/${TENANT_ID}/care/${AGGREGATE_ID}`,
      time: OCCURRED_AT,
      tenantId: TENANT_ID,
      traceId: actor.traceId,
      schemaVersion: '1',
      data: {
        tenantId: TENANT_ID,
        aggregateId: AGGREGATE_ID,
        version: 2,
        ...event.payload,
      },
    });
    expect(rows[0]!.envelope.data).not.toHaveProperty('personId');
    expect(rows[0]!.envelope.data).not.toHaveProperty('evidenceId');
  });

  it.each([
    [{ ...validEvents[0], unknown: true }],
    [{ ...validEvents[0], type: 'care.case.unknown' }],
    [{ ...validEvents[0], tenantId: '../tenant' }],
    [{ ...validEvents[0], aggregateId: '' }],
    [{ ...validEvents[0], version: 0 }],
    [{ ...validEvents[0], version: 1.5 }],
    [{ ...validEvents[0], version: Number.MAX_SAFE_INTEGER + 1 }],
    [{ ...validEvents[0], occurredAt: '2026-07-22T10:00:00Z' }],
    [{ ...validEvents[0], payload: null }],
    [{ ...validEvents[0], payload: { ...validEvents[0]!.payload, status: 'completed' } }],
    [{
      ...validEvents[4],
      payload: { ...validEvents[4]!.payload, taskCode: 'password_reset' },
    }],
    [{
      ...validEvents[8],
      payload: { ...validEvents[8]!.payload, channels: ['wechat', 'email'] },
    }],
    [{
      ...validEvents[8],
      payload: { ...validEvents[8]!.payload, channels: ['email', 'email'] },
    }],
    [{
      ...validEvents[8],
      payload: { ...validEvents[8]!.payload, personId: 'person-001' },
    }],
    [{
      ...validEvents[11],
      payload: { ...validEvents[11]!.payload, attempts: 1 },
    }],
    [{
      ...validEvents[13],
      payload: { ...validEvents[13]!.payload, attempts: 0 },
    }],
    [{
      ...validEvents[15],
      payload: { ...validEvents[15]!.payload, unsubscribed: true },
    }],
    [{
      ...validEvents[16],
      payload: { ...validEvents[16]!.payload, birthdayEnabled: true },
    }],
    [{
      ...validEvents[18],
      payload: { ...validEvents[18]!.payload, attempts: 0 },
    }],
    [{
      ...validEvents[19],
      payload: { ...validEvents[19]!.payload, denialCode: 'unknown' },
    }],
    [{
      ...validEvents[20],
      payload: { ...validEvents[20]!.payload, email: 'sensitive@example.invalid' },
    }],
    [{
      ...validEvents[21],
      payload: { ...validEvents[21]!.payload, reasonCode: 'free text' },
    }],
  ])('拒绝伪造、越权状态或额外敏感字段 %#', async (event) => {
    const { writer, create } = setup();

    await expect(writer.append(event as PublishedEvent, session))
      .rejects.toThrow('CARE_OUTBOX_EVENT_INVALID');
    expect(create).not.toHaveBeenCalled();
  });

  it('拒绝事件租户与可信租户不一致', async () => {
    const { writer, create } = setup();
    const event = { ...validEvents[0]!, tenantId: 'tenant-002' };

    await expect(writer.append(event, session)).rejects.toThrow(
      'CARE_OUTBOX_TENANT_MISMATCH',
    );
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
      'CARE_OUTBOX_CONTEXT_INVALID',
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
    )).rejects.toThrow('CARE_OUTBOX_TRANSACTION_REQUIRED');
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
      'CARE_OUTBOX_WRITE_UNAVAILABLE',
    );
  });

  it('拒绝被篡改的完整数据库回执', async () => {
    const { writer, create } = setup();
    create.mockImplementationOnce((rows) => {
      const row = rows[0]!;
      return Promise.resolve([{
        ...row,
        envelope: { ...row.envelope, traceId: 'trace-tampered' },
      }]);
    });

    await expect(writer.append(validEvents[0]!, session)).rejects.toThrow(
      'CARE_OUTBOX_WRITE_UNAVAILABLE',
    );
  });

  it('保留数据库异常供事务上层分类且不伪造终态', async () => {
    const { writer, create } = setup();
    const failure = new Error('mongo unavailable');
    create.mockRejectedValueOnce(failure);

    await expect(writer.append(validEvents[0]!, session)).rejects.toBe(failure);
  });

  it('使用规范化副本阻止调用方在写入期间篡改载荷', async () => {
    const mutable = {
      ...validEvents[0]!,
      payload: { ...validEvents[0]!.payload },
    } as PublishedEvent;
    const { writer, create } = setup();
    create.mockImplementationOnce((rows) => {
      (mutable.payload as Record<string, unknown>)['personId'] = 'person-001';
      return Promise.resolve(rows);
    });

    await writer.append(mutable, session);

    const rows = create.mock.calls[0]![0];
    expect(rows[0]!.envelope.data).not.toHaveProperty('personId');
  });
});

function setup(
  getRequired: () => unknown = () => trusted,
): {
  readonly writer: CareOutboxWriter;
  readonly create: Mock<CreateOutbox>;
} {
  const context = {
    getRequired: vi.fn(getRequired),
  } as unknown as TenantContextService;
  const create = vi.fn<CreateOutbox>((rows) => Promise.resolve(rows));
  const records = { create } as unknown as Model<OutboxDocument>;
  return {
    writer: new CareOutboxWriter(context, records),
    create,
  };
}

function careCaseEvent(
  type: CareDomainEvent['type'],
  status: string,
): CareDomainEvent {
  return {
    ...base,
    type,
    payload: { ...careCasePayload, status },
  };
}

function consentEvent(
  type: AlumniConsentDomainEvent['type'],
  status: string,
): AlumniConsentDomainEvent {
  return {
    ...base,
    type,
    payload: { ...consentPayload, status },
  };
}

function cleanupEvent(
  type: AlumniCleanupDomainEvent['type'],
  status: string,
  attempts: number,
): AlumniCleanupDomainEvent {
  return {
    ...base,
    type,
    payload: { ...cleanupPayload, status, attempts },
  };
}

function occasionEvent(
  type: CareOccasionDomainEvent['type'],
  status: string,
  attempts: number,
): CareOccasionDomainEvent {
  return {
    ...base,
    type,
    payload: { ...occasionPayload, status, attempts },
  };
}
