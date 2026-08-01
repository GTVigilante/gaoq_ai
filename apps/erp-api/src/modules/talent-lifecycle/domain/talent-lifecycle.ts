export type TalentLifecycleStage =
  | 'talent_pool'
  | 'recruiting'
  | 'offer'
  | 'onboarding'
  | 'employed'
  | 'offboarding'
  | 'alumni'
  | 'former_employee'
  | 'inactive';

export type TalentTouchpointKind =
  | 'candidate_outreach'
  | 'interview_support'
  | 'offer_support'
  | 'onboarding_support'
  | 'employee_care'
  | 'offboarding_support'
  | 'alumni_engagement'
  | 'rehire_contact';

export type TalentTouchpointChannel =
  | 'email'
  | 'phone'
  | 'wechat'
  | 'meeting'
  | 'portal'
  | 'internal';

export type TalentTouchpointOutcome =
  | 'contacted'
  | 'no_response'
  | 'follow_up_required'
  | 'resolved'
  | 'declined'
  | 'joined'
  | 'departed'
  | 'consent_withdrawn';

export type TalentTouchpointStatus = 'open' | 'completed' | 'cancelled';

export interface TalentTouchpoint {
  readonly id: string;
  readonly tenantId: string;
  readonly candidateId: string;
  readonly kind: TalentTouchpointKind;
  readonly channel: TalentTouchpointChannel;
  readonly direction: 'inbound' | 'outbound' | 'internal';
  readonly outcome: TalentTouchpointOutcome;
  readonly ownerActorId: string;
  readonly occurredAt: string;
  readonly nextActionAt: string | null;
  readonly status: TalentTouchpointStatus;
  readonly note: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function createTalentTouchpoint(
  input: Omit<TalentTouchpoint, 'status' | 'version' | 'createdAt' | 'updatedAt'>,
  now: Date,
): TalentTouchpoint {
  const occurredAt = canonicalIso(input.occurredAt, '服务发生时间');
  const nextActionAt = input.nextActionAt === null
    ? null
    : canonicalIso(input.nextActionAt, '下一步行动时间');
  if (
    Date.parse(occurredAt) < now.getTime() - 366 * 24 * 60 * 60 * 1_000 ||
    Date.parse(occurredAt) > now.getTime() + 5 * 60 * 1_000
  ) throw new Error('TALENT_TOUCHPOINT_OCCURRED_AT_INVALID');
  if (
    nextActionAt !== null &&
    (
      Date.parse(nextActionAt) <= Date.parse(occurredAt) ||
      Date.parse(nextActionAt) > now.getTime() + 2 * 366 * 24 * 60 * 60 * 1_000
    )
  ) throw new Error('TALENT_TOUCHPOINT_NEXT_ACTION_INVALID');
  const note = input.note?.normalize('NFKC').trim() ?? null;
  if (note !== null && (note.length < 1 || note.length > 1_000)) {
    throw new Error('TALENT_TOUCHPOINT_NOTE_INVALID');
  }
  const timestamp = now.toISOString();
  return Object.freeze({
    ...input,
    occurredAt,
    nextActionAt,
    note,
    status: nextActionAt === null ? 'completed' : 'open',
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

export function closeTalentTouchpoint(
  current: TalentTouchpoint,
  input: {
    readonly tenantId: string;
    readonly expectedVersion: number;
    readonly status: 'completed' | 'cancelled';
  },
  now: Date,
): TalentTouchpoint {
  if (current.tenantId !== input.tenantId) throw new Error('TALENT_TOUCHPOINT_CROSS_TENANT');
  if (current.version !== input.expectedVersion) throw new Error('TALENT_TOUCHPOINT_VERSION_CONFLICT');
  if (current.status !== 'open') throw new Error('TALENT_TOUCHPOINT_ALREADY_CLOSED');
  return Object.freeze({
    ...current,
    status: input.status,
    version: current.version + 1,
    updatedAt: now.toISOString(),
  });
}

function canonicalIso(value: string, field: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    throw new Error(`${field}必须为规范 UTC ISO 时间`);
  }
  return value;
}
