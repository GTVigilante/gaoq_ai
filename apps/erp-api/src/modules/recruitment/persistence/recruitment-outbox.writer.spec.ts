import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession, Model } from 'mongoose';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { OutboxDocument } from '../../org/persistence/outbox.schema.js';
import type { RecruitmentDomainEvent } from '../domain/recruitment-events.js';
import { RecruitmentOutboxWriter } from './recruitment-outbox.writer.js';

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
const OCCURRED_AT = '2026-07-28T01:00:00.000Z';
const actor: ActorContext = {
  actorType: 'service',
  actorId: 'recruitment-service',
  tenantId: TENANT_ID,
  roleCodes: [],
  scopes: [],
  departmentIds: [],
  traceId: 'trace-recruitment-001',
};
const trusted = {
  tenant: { tenantId: TENANT_ID, source: 'access_token' as const },
  actor,
};
const session = {
  inTransaction: vi.fn(() => true),
} as unknown as ClientSession;

const applicationCreated = {
  candidateId: 'candidate-001',
  positionId: 'position-001',
  consentEvidenceId: 'consent-001',
  sourceChannel: 'portal',
  stage: 'applied',
} as const;
const applicationStage = {
  from: 'applied',
  to: 'screening',
  actorId: 'actor-001',
  reasonCode: null,
  evidenceId: null,
} as const;
const requisitionCreated = {
  departmentId: 'department-001',
  headcount: 2,
  status: 'draft',
  approvalInstanceId: null,
  approvalHistoryId: null,
} as const;
const positionCreated = {
  requisitionId: 'requisition-001',
  departmentId: 'department-001',
  headcount: 2,
  status: 'draft',
} as const;
const interviewTimes = {
  startsAt: '2026-07-30T01:00:00.000Z',
  endsAt: '2026-07-30T02:00:00.000Z',
} as const;
const offerBase = {
  applicationId: 'application-001',
  positionId: 'position-001',
  approvalInstanceId: 'approval-001',
  approvalHistoryId: null,
  sendRequestId: null,
  sentEvidenceId: null,
  acceptanceEvidenceId: null,
  esignFlowId: null,
  signedEvidenceId: null,
} as const;

const validEvents: readonly RecruitmentDomainEvent[] = [
  event('recruitment.application.created', 'recruitment.application', applicationCreated),
  event('recruitment.application.stage_changed', 'recruitment.application', applicationStage),
  event('recruitment.application.migrated', 'recruitment.application', {
    candidateId: 'candidate-001',
    positionId: 'position-001',
    stage: 'interview',
  }),
  event('recruitment.candidate.migrated', 'recruitment.candidate', {
    status: 'active',
    consentEvidenceId: 'consent-001',
    consentVersion: 'v1',
  }),
  event('recruitment.requisition.created', 'recruitment.requisition', requisitionCreated),
  event('recruitment.requisition.submitted', 'recruitment.requisition', {
    ...requisitionCreated,
    status: 'pending_approval',
    approvalInstanceId: 'approval-001',
  }),
  event('recruitment.requisition.approved', 'recruitment.requisition', {
    ...requisitionCreated,
    status: 'approved',
    approvalInstanceId: 'approval-001',
  }),
  event('recruitment.requisition.rejected', 'recruitment.requisition', {
    ...requisitionCreated,
    status: 'rejected',
    approvalInstanceId: 'approval-001',
  }),
  event('recruitment.requisition.closed', 'recruitment.requisition', {
    ...requisitionCreated,
    status: 'closed',
    approvalInstanceId: null,
    approvalHistoryId: 'approval-history-001',
  }),
  event('recruitment.requisition.migrated', 'recruitment.requisition', {
    ...requisitionCreated,
    status: 'approved',
    approvalHistoryId: 'approval-history-001',
  }),
  event('recruitment.position.created', 'recruitment.position', positionCreated),
  event('recruitment.position.status_changed', 'recruitment.position', {
    ...positionCreated,
    status: 'open',
  }),
  event('recruitment.position.migrated', 'recruitment.position', {
    ...positionCreated,
    status: 'paused',
  }),
  event('recruitment.interview.scheduled', 'recruitment.interview', {
    applicationId: 'application-001',
    roundNumber: 1,
    status: 'scheduled',
    ...interviewTimes,
  }),
  event(
    'recruitment.interview.feedback_submitted',
    'recruitment.interview_feedback',
    {
      applicationId: 'application-001',
      feedbackId: 'recruitment.interview_feedback-001',
      interviewerId: 'employee-001',
    },
  ),
  event('recruitment.interview.completed', 'recruitment.interview', {
    applicationId: 'application-001',
    roundNumber: 1,
    status: 'completed',
    ...interviewTimes,
  }),
  event('recruitment.interview.cancelled', 'recruitment.interview', {
    applicationId: 'application-001',
    roundNumber: 1,
    status: 'cancelled',
    ...interviewTimes,
  }),
  event('recruitment.interview.migrated', 'recruitment.interview', {
    applicationId: 'application-001',
    roundNumber: 1,
    status: 'completed',
    feedbackCount: 0,
  }, 2),
  event('recruitment.offer.created', 'recruitment.offer', {
    ...offerBase,
    status: 'draft',
    approvalInstanceId: null,
  }),
  event('recruitment.offer.submitted', 'recruitment.offer', {
    ...offerBase,
    status: 'pending_approval',
  }),
  event('recruitment.offer.approved', 'recruitment.offer', {
    ...offerBase,
    status: 'approved',
  }),
  event('recruitment.offer.rejected', 'recruitment.offer', {
    ...offerBase,
    status: 'rejected',
  }),
  event('recruitment.offer.send_requested', 'recruitment.offer', {
    ...offerBase,
    status: 'sending',
    sendRequestId: 'send-001',
  }),
  event('recruitment.offer.sent', 'recruitment.offer', {
    ...offerBase,
    status: 'sent',
    sendRequestId: 'send-001',
    sentEvidenceId: 'sent-001',
  }),
  event('recruitment.offer.accepted', 'recruitment.offer', {
    ...offerBase,
    status: 'accepted',
    sendRequestId: 'send-001',
    sentEvidenceId: 'sent-001',
    acceptanceEvidenceId: 'acceptance-001',
  }),
  event('recruitment.offer.declined', 'recruitment.offer', {
    ...offerBase,
    status: 'declined',
    sendRequestId: 'send-001',
    sentEvidenceId: 'sent-001',
    acceptanceEvidenceId: 'acceptance-001',
  }),
  event('recruitment.offer.expired', 'recruitment.offer', {
    ...offerBase,
    status: 'expired',
    sendRequestId: 'send-001',
    sentEvidenceId: 'sent-001',
  }),
  event('recruitment.offer.signed', 'recruitment.offer', {
    ...offerBase,
    status: 'signed',
    sendRequestId: 'send-001',
    sentEvidenceId: 'sent-001',
    acceptanceEvidenceId: 'acceptance-001',
    esignFlowId: 'esign-flow-001',
    signedEvidenceId: 'signed-001',
  }),
  event('recruitment.offer.migrated', 'recruitment.offer', {
    applicationId: 'application-001',
    positionId: 'position-001',
    completedInterviewId: 'interview-001',
    status: 'signed',
    approvalInstanceId: null,
    approvalHistoryId: 'approval-history-001',
  }),
  event('recruitment.resume_analysis.requested', 'recruitment.resume_analysis', {
    candidateId: 'candidate-001',
    resumeEvidenceId: 'resume-001',
    status: 'queued',
    confirmedTagCount: 0,
  }),
  event('recruitment.resume_analysis.reviewed', 'recruitment.resume_analysis', {
    candidateId: 'candidate-001',
    resumeEvidenceId: 'resume-001',
    status: 'approved',
    confirmedTagCount: 3,
  }),
  event('recruitment.interview.migrated', 'recruitment.interview', {
    applicationId: 'application-001',
    roundNumber: 2,
    status: 'scheduled',
    feedbackCount: 0,
  }),
  event('recruitment.offer.migrated', 'recruitment.offer', {
    applicationId: 'application-001',
    positionId: 'position-001',
    completedInterviewId: 'interview-001',
    status: 'draft',
    approvalInstanceId: null,
    approvalHistoryId: null,
  }),
  event('recruitment.offer.migrated', 'recruitment.offer', {
    applicationId: 'application-001',
    positionId: 'position-001',
    completedInterviewId: 'interview-001',
    status: 'pending_approval',
    approvalInstanceId: 'approval-001',
    approvalHistoryId: null,
  }),
];

describe('RecruitmentOutboxWriter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(validEvents)('按逐类型白名单发布 $type', async (published) => {
    const { writer, create } = setup();

    const envelope = await writer.append(published, session);

    expect(create).toHaveBeenCalledTimes(1);
    const [rows, options] = create.mock.calls[0]!;
    expect(options).toEqual({ session });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.eventId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
    expect(rows[0]).toMatchObject({
      tenantId: TENANT_ID,
      aggregateType: published.aggregateType,
      aggregateId: published.aggregateId,
      aggregateVersion: published.version,
      eventType: `cn.gaoq.erp.${published.type}.v1`,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date(OCCURRED_AT),
    });
    expect(envelope).toEqual(rows[0]!.envelope);
    expect(envelope).toMatchObject({
      specversion: '1.0',
      source: '//gaoq-erp/recruitment-module',
      type: `cn.gaoq.erp.${published.type}.v1`,
      subject:
        `tenant/${TENANT_ID}/${published.aggregateType}/${published.aggregateId}`,
      time: OCCURRED_AT,
      datacontenttype: 'application/json',
      tenantId: TENANT_ID,
      traceId: actor.traceId,
      idempotencyKey:
        `${TENANT_ID}:cn.gaoq.erp.${published.type}.v1:${published.aggregateId}:${published.version}`,
      schemaVersion: '1',
      data: {
        ...published.payload,
        tenantId: TENANT_ID,
        aggregateId: published.aggregateId,
        version: published.version,
      },
    });
    expect(JSON.stringify(rows[0])).not.toMatch(
      /token|secret|password|credential|authorization|benefitsSummary|monthlyBaseSalary/iu,
    );
  });

  it.each([
    [{ ...validEvents[0], unknown: true }],
    [{ ...validEvents[0], type: 'recruitment.application.deleted' }],
    [{ ...validEvents[0], aggregateType: 'recruitment.offer' }],
    [{ ...validEvents[0], tenantId: '../tenant' }],
    [{ ...validEvents[0], aggregateId: '' }],
    [{ ...validEvents[0], version: 0 }],
    [{ ...validEvents[0], version: 1.5 }],
    [{ ...validEvents[0], version: Number.MAX_SAFE_INTEGER + 1 }],
    [{ ...validEvents[0], occurredAt: '2026-07-28T01:00:00Z' }],
    [{ ...validEvents[0], occurredAt: '2999-01-01T00:00:00.000Z' }],
    [{ ...validEvents[0], payload: null }],
    [{ ...validEvents[0], payload: { ...applicationCreated, stage: 'screening' } }],
    [{
      ...validEvents[0],
      payload: { ...applicationCreated, candidateName: '候选人原文' },
    }],
    [{
      ...validEvents[1],
      payload: { ...applicationStage, from: 'hired', to: 'screening' },
    }],
    [{
      ...validEvents[1],
      payload: { ...applicationStage, to: 'rejected', reasonCode: null },
    }],
    [{
      ...validEvents[1],
      payload: { ...applicationStage, from: 'interview', to: 'offer_approval' },
    }],
    [{
      ...validEvents[4],
      payload: { ...requisitionCreated, headcount: 10_001 },
    }],
    [{
      ...validEvents[5],
      payload: { ...validEvents[5]!.payload, approvalInstanceId: null },
    }],
    [{
      ...validEvents[9],
      payload: {
        ...validEvents[9]!.payload,
        approvalInstanceId: 'approval-001',
        approvalHistoryId: 'approval-history-001',
      },
    }],
    [{
      ...validEvents[11],
      payload: { ...validEvents[11]!.payload, status: 'draft' },
    }],
    [{
      ...validEvents[13],
      payload: { ...validEvents[13]!.payload, roundNumber: 0 },
    }],
    [{
      ...validEvents[13],
      payload: {
        ...validEvents[13]!.payload,
        endsAt: interviewTimes.startsAt,
      },
    }],
    [{
      ...validEvents[14],
      payload: { ...validEvents[14]!.payload, feedbackId: 'feedback-other' },
    }],
    [{
      ...validEvents[17],
      payload: { ...validEvents[17]!.payload, feedbackCount: 1 },
    }],
    [{
      ...validEvents[18],
      payload: {
        ...validEvents[18]!.payload,
        approvalInstanceId: 'approval-001',
      },
    }],
    [{
      ...validEvents[22],
      payload: {
        ...validEvents[22]!.payload,
        sentEvidenceId: 'sent-001',
      },
    }],
    [{
      ...validEvents[24],
      payload: {
        ...validEvents[24]!.payload,
        acceptanceEvidenceId: null,
      },
    }],
    [{
      ...validEvents[27],
      payload: {
        ...validEvents[27]!.payload,
        token: 'upstream-token',
      },
    }],
    [{
      ...validEvents[28],
      payload: {
        ...validEvents[28]!.payload,
        approvalInstanceId: 'approval-001',
      },
    }],
    [{
      ...validEvents[29],
      payload: {
        ...validEvents[29]!.payload,
        confirmedTagCount: 1,
      },
    }],
  ])('拒绝伪造状态、错配聚合或敏感负载 %#', async (candidate) => {
    const { writer, create } = setup();

    await expect(writer.append(
      candidate as RecruitmentDomainEvent,
      session,
    )).rejects.toThrow('RECRUITMENT_OUTBOX_EVENT_INVALID');
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    {
      ...offerBase,
      status: 'approved',
      approvalInstanceId: null,
      approvalHistoryId: 'approval-history-001',
    },
    {
      ...offerBase,
      status: 'expired',
      sendRequestId: 'send-001',
    },
    {
      ...offerBase,
      status: 'expired',
    },
  ])('接受在线或迁移审批引用及合法过期阶段 %#', async (payload) => {
    const type = payload.status === 'approved'
      ? 'recruitment.offer.approved'
      : 'recruitment.offer.expired';
    const { writer, create } = setup();

    await expect(writer.append(
      event(type, 'recruitment.offer', payload),
      session,
    )).resolves.toMatchObject({ type: `cn.gaoq.erp.${type}.v1` });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('拒绝事件租户与可信租户不一致', async () => {
    const { writer, create } = setup();

    await expect(writer.append(
      { ...validEvents[0]!, tenantId: 'tenant-002' },
      session,
    )).rejects.toThrow('RECRUITMENT_OUTBOX_TENANT_MISMATCH');
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
      'RECRUITMENT_OUTBOX_CONTEXT_INVALID',
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
    )).rejects.toThrow('RECRUITMENT_OUTBOX_TRANSACTION_REQUIRED');
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
      'RECRUITMENT_OUTBOX_WRITE_UNAVAILABLE',
    );
  });

  it('拒绝被篡改的完整数据库回执', async () => {
    const { writer, create } = setup();
    create.mockImplementationOnce((rows) => Promise.resolve([{
      ...rows[0]!,
      envelope: { ...rows[0]!.envelope, traceId: 'trace-tampered' },
    }]));

    await expect(writer.append(validEvents[0]!, session)).rejects.toThrow(
      'RECRUITMENT_OUTBOX_WRITE_UNAVAILABLE',
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
    } as RecruitmentDomainEvent;
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
  readonly writer: RecruitmentOutboxWriter;
  readonly create: Mock<CreateOutbox>;
} {
  const context = {
    getRequired: vi.fn(getRequired),
  } as unknown as TenantContextService;
  const create = vi.fn<CreateOutbox>((rows) => Promise.resolve(rows));
  const records = { create } as unknown as Model<OutboxDocument>;
  return {
    writer: new RecruitmentOutboxWriter(context, records),
    create,
  };
}

function event(
  type: RecruitmentDomainEvent['type'],
  aggregateType: RecruitmentDomainEvent['aggregateType'],
  payload: Readonly<Record<string, string | number | null>>,
  version = 1,
): RecruitmentDomainEvent {
  return {
    type,
    aggregateType,
    tenantId: TENANT_ID,
    aggregateId: `${aggregateType}-001`,
    version,
    occurredAt: OCCURRED_AT,
    payload,
  };
}
