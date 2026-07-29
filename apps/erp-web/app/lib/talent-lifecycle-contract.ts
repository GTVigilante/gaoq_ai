export type LifecycleStage =
  | 'talent_pool'
  | 'recruiting'
  | 'offer'
  | 'onboarding'
  | 'employed'
  | 'offboarding'
  | 'alumni'
  | 'former_employee'
  | 'inactive';

export interface LifecycleSummary {
  readonly candidateId: string;
  readonly displayName: string | null;
  readonly stage: LifecycleStage;
  readonly candidateStatus: 'active' | 'consent_withdrawn' | 'anonymized';
  readonly currentApplicationStage: string | null;
  readonly currentPositionTitle: string | null;
  readonly employeeStatus: string | null;
  readonly activeCareStatus: string | null;
  readonly alumniConsentStatus: string | null;
  readonly openFollowUpCount: number;
  readonly nextActionAt: string | null;
  readonly updatedAt: string;
}

export interface TimelineEntry {
  readonly id: string;
  readonly domain: 'recruitment' | 'onboarding' | 'org' | 'care' | 'alumni' | 'service';
  readonly eventType: string;
  readonly title: string;
  readonly occurredAt: string;
  readonly referenceType: string;
  readonly referenceId: string;
}

export interface Touchpoint {
  readonly id: string;
  readonly candidateId: string;
  readonly kind: TouchpointKind;
  readonly channel: TouchpointChannel;
  readonly direction: TouchpointDirection;
  readonly outcome: TouchpointOutcome;
  readonly ownerActorId: string;
  readonly occurredAt: string;
  readonly nextActionAt: string | null;
  readonly status: 'open' | 'completed' | 'cancelled';
  readonly note: string | null;
  readonly version: number;
}

export interface LifecycleDetail extends LifecycleSummary {
  readonly personId: string | null;
  readonly applications: readonly {
    readonly id: string;
    readonly positionTitle: string;
    readonly stage: string;
    readonly sourceChannel: string;
    readonly appliedAt: string;
  }[];
  readonly onboarding: readonly {
    readonly id: string;
    readonly status: string;
    readonly proposedStartDate: string;
  }[];
  readonly employments: readonly {
    readonly id: string;
    readonly employeeNo: string;
    readonly displayName: string;
    readonly status: string;
    readonly effectiveFrom: string;
    readonly effectiveTo: string | null;
  }[];
  readonly care: {
    readonly cases: readonly {
      readonly id: string;
      readonly status: string;
      readonly lastWorkingDate: string;
    }[];
    readonly alumniConsents: readonly {
      readonly id: string;
      readonly purpose: string;
      readonly status: string;
      readonly expiresAt: string;
    }[];
  };
  readonly touchpoints: readonly Touchpoint[];
  readonly timeline: readonly TimelineEntry[];
}

export type TouchpointKind =
  | 'candidate_outreach'
  | 'interview_support'
  | 'offer_support'
  | 'onboarding_support'
  | 'employee_care'
  | 'offboarding_support'
  | 'alumni_engagement'
  | 'rehire_contact';

export type TouchpointChannel =
  | 'email'
  | 'phone'
  | 'wechat'
  | 'meeting'
  | 'portal'
  | 'internal';

export type TouchpointDirection = 'inbound' | 'outbound' | 'internal';

export type TouchpointOutcome =
  | 'contacted'
  | 'no_response'
  | 'follow_up_required'
  | 'resolved'
  | 'declined'
  | 'joined'
  | 'departed'
  | 'consent_withdrawn';

export interface TouchpointCreateInput {
  readonly kind: TouchpointKind;
  readonly channel: TouchpointChannel;
  readonly direction: TouchpointDirection;
  readonly outcome: TouchpointOutcome;
  readonly occurredAt: string;
  readonly nextActionAt?: string;
  readonly note?: string;
}

export interface TouchpointMutationResult {
  readonly touchpoint: Omit<Touchpoint, 'note'>;
}

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-([012]\d|3[01])$/u;
const SUMMARY_KEYS = [
  'candidateId', 'displayName', 'stage', 'candidateStatus',
  'currentApplicationStage', 'currentPositionTitle', 'employeeStatus',
  'activeCareStatus', 'alumniConsentStatus', 'openFollowUpCount',
  'nextActionAt', 'updatedAt',
] as const;
const DETAIL_KEYS = [
  ...SUMMARY_KEYS,
  'personId', 'applications', 'onboarding', 'employments',
  'care', 'touchpoints', 'timeline',
] as const;
const TOUCHPOINT_KEYS = [
  'id', 'candidateId', 'kind', 'channel', 'direction', 'outcome',
  'ownerActorId', 'occurredAt', 'nextActionAt', 'status', 'note', 'version',
] as const;
const TOUCHPOINT_MUTATION_KEYS = TOUCHPOINT_KEYS.filter((key) => key !== 'note');
const STAGES = new Set<LifecycleStage>([
  'talent_pool', 'recruiting', 'offer', 'onboarding', 'employed',
  'offboarding', 'alumni', 'former_employee', 'inactive',
]);
const CANDIDATE_STATUSES = new Set(['active', 'consent_withdrawn', 'anonymized']);
const APPLICATION_STAGES = new Set([
  'applied', 'screening', 'interview', 'offer_approval', 'offer_sent',
  'offer_accepted', 'preboarding', 'hired', 'rejected', 'withdrawn',
]);
const EMPLOYEE_STATUSES = new Set(['probation', 'active', 'suspended', 'terminated']);
const EMPLOYMENT_STATUSES = new Set(['probation', 'active', 'suspended', 'resigned']);
const ONBOARDING_STATUSES = new Set([
  'in_progress', 'ready', 'provisioning', 'completed', 'cancelled',
]);
const CARE_STATUSES = new Set([
  'draft', 'pending_approval', 'approved', 'clearing', 'ready',
  'scheduled', 'executing', 'completed', 'cancelled',
]);
const CONSENT_STATUSES = new Set(['active', 'withdrawn', 'expired']);
const CONSENT_PURPOSES = new Set(['alumni_network', 'rehire_contact', 'alumni_events']);
const TOUCHPOINT_KINDS = new Set<TouchpointKind>([
  'candidate_outreach', 'interview_support', 'offer_support', 'onboarding_support',
  'employee_care', 'offboarding_support', 'alumni_engagement', 'rehire_contact',
]);
const TOUCHPOINT_CHANNELS = new Set<TouchpointChannel>([
  'email', 'phone', 'wechat', 'meeting', 'portal', 'internal',
]);
const TOUCHPOINT_DIRECTIONS = new Set<TouchpointDirection>(['inbound', 'outbound', 'internal']);
const TOUCHPOINT_OUTCOMES = new Set<TouchpointOutcome>([
  'contacted', 'no_response', 'follow_up_required', 'resolved',
  'declined', 'joined', 'departed', 'consent_withdrawn',
]);
const TOUCHPOINT_STATUSES = new Set<Touchpoint['status']>(['open', 'completed', 'cancelled']);
const TIMELINE_DOMAINS = new Set<TimelineEntry['domain']>([
  'recruitment', 'onboarding', 'org', 'care', 'alumni', 'service',
]);

/** PC 只有同时具备读取与触点写 Scope 才展示 R2 写入口。 */
export function canWriteTalentTouchpoint(scopes: readonly string[]): boolean {
  return scopes.includes('erp:talent-lifecycle:read') &&
    scopes.includes('erp:talent-lifecycle:touchpoint:write');
}

/** 关闭操作还必须由责任人本人或具有跨责任人 Scope 的主体执行。 */
export function canCloseTalentTouchpoint(
  profile: { readonly actorId: string; readonly scopes: readonly string[] } | null,
  touchpoint: Pick<Touchpoint, 'ownerActorId' | 'status'>,
): boolean {
  return profile !== null &&
    touchpoint.status === 'open' &&
    canWriteTalentTouchpoint(profile.scopes) &&
    (
      profile.actorId === touchpoint.ownerActorId ||
      profile.scopes.includes('erp:talent-lifecycle:touchpoint:write_all')
    );
}

/** 结果未知的重试必须仍由创建原请求的同一可信主体执行。 */
export function canRetryTalentTouchpoint(
  profile: { readonly actorId: string; readonly scopes: readonly string[] } | null,
  attemptedActorId: string,
  ownerActorId?: string,
): boolean {
  if (
    profile === null ||
    profile.actorId !== attemptedActorId ||
    !canWriteTalentTouchpoint(profile.scopes)
  ) return false;
  return ownerActorId === undefined ||
    profile.actorId === ownerActorId ||
    profile.scopes.includes('erp:talent-lifecycle:touchpoint:write_all');
}

/** 严格校验人才列表公开投影，禁止内部字段静默进入浏览器。 */
export function parseTalentLifecycleList(value: unknown): readonly LifecycleSummary[] {
  const record = objectRecord(value, 'TALENT_LIFECYCLE_LIST_INVALID');
  if (!exactKeys(record, ['items']) || !Array.isArray(record.items) || record.items.length > 100) {
    throw new Error('TALENT_LIFECYCLE_LIST_INVALID');
  }
  const items = Object.freeze(record.items.map(parseSummary));
  if (new Set(items.map((item) => item.candidateId)).size !== items.length) {
    throw new Error('TALENT_LIFECYCLE_LIST_INVALID');
  }
  return items;
}

/** 严格校验人才详情公开投影及全部跨域数组边界。 */
export function parseTalentLifecycleDetail(value: unknown): LifecycleDetail {
  const record = objectRecord(value, 'TALENT_LIFECYCLE_DETAIL_INVALID');
  if (
    !exactKeys(record, DETAIL_KEYS) ||
    !nullableUlid(record.personId) ||
    !Array.isArray(record.applications) || record.applications.length > 100 ||
    !Array.isArray(record.onboarding) || record.onboarding.length > 100 ||
    !Array.isArray(record.employments) || record.employments.length > 100 ||
    !Array.isArray(record.touchpoints) || record.touchpoints.length > 500 ||
    !Array.isArray(record.timeline) || record.timeline.length > 2_000
  ) throw new Error('TALENT_LIFECYCLE_DETAIL_INVALID');
  const summary = parseSummaryRecord(record);
  const applications = Object.freeze(record.applications.map(parseApplication));
  const onboarding = Object.freeze(record.onboarding.map(parseOnboarding));
  const employments = Object.freeze(record.employments.map(parseEmployment));
  const care = parseCare(record.care);
  const touchpoints = Object.freeze(record.touchpoints.map((item) => parseTouchpoint(item)));
  const timeline = Object.freeze(record.timeline.map(parseTimelineEntry));
  if (
    touchpoints.some((item) => item.candidateId !== summary.candidateId) ||
    !uniqueById(applications) ||
    !uniqueById(onboarding) ||
    !uniqueById(employments) ||
    !uniqueById(care.cases) ||
    !uniqueById(care.alumniConsents) ||
    !uniqueById(touchpoints) ||
    !uniqueById(timeline)
  ) throw new Error('TALENT_LIFECYCLE_DETAIL_INVALID');
  return Object.freeze({
    ...summary,
    personId: record.personId as string | null,
    applications,
    onboarding,
    employments,
    care,
    touchpoints,
    timeline,
  });
}

/** 校验触点创建或关闭写响应仍为最小公开投影。 */
export function parseTouchpointMutationResult(value: unknown): TouchpointMutationResult {
  const record = objectRecord(value, 'TALENT_TOUCHPOINT_RESULT_INVALID');
  if (!exactKeys(record, ['touchpoint'])) throw new Error('TALENT_TOUCHPOINT_RESULT_INVALID');
  const parsed = parseTouchpoint(record.touchpoint, false);
  return Object.freeze({
    touchpoint: Object.freeze({
      id: parsed.id,
      candidateId: parsed.candidateId,
      kind: parsed.kind,
      channel: parsed.channel,
      direction: parsed.direction,
      outcome: parsed.outcome,
      ownerActorId: parsed.ownerActorId,
      occurredAt: parsed.occurredAt,
      nextActionAt: parsed.nextActionAt,
      status: parsed.status,
      version: parsed.version,
    }),
  });
}

/** 将表单压缩为服务端允许的触点创建白名单，并规范化浏览器本地时间。 */
export function buildTouchpointCreateInput(value: unknown): TouchpointCreateInput {
  const record = objectRecord(value, 'TALENT_TOUCHPOINT_INPUT_INVALID');
  if (!allowedKeys(record, [
    'kind', 'channel', 'direction', 'outcome', 'occurredAt', 'nextActionAt', 'note',
  ])) throw new Error('TALENT_TOUCHPOINT_INPUT_INVALID');
  if (
    typeof record.kind !== 'string' || !TOUCHPOINT_KINDS.has(record.kind as TouchpointKind) ||
    typeof record.channel !== 'string' ||
    !TOUCHPOINT_CHANNELS.has(record.channel as TouchpointChannel) ||
    typeof record.direction !== 'string' ||
    !TOUCHPOINT_DIRECTIONS.has(record.direction as TouchpointDirection) ||
    typeof record.outcome !== 'string' ||
    !TOUCHPOINT_OUTCOMES.has(record.outcome as TouchpointOutcome) ||
    typeof record.occurredAt !== 'string'
  ) throw new Error('TALENT_TOUCHPOINT_INPUT_INVALID');
  const occurredAt = canonicalInputInstant(record.occurredAt);
  if (
    record.nextActionAt !== undefined &&
    record.nextActionAt !== '' &&
    typeof record.nextActionAt !== 'string'
  ) throw new Error('TALENT_TOUCHPOINT_INPUT_INVALID');
  const nextActionAt = record.nextActionAt === undefined || record.nextActionAt === ''
    ? undefined
    : canonicalInputInstant(record.nextActionAt);
  if (nextActionAt !== undefined && Date.parse(nextActionAt) <= Date.parse(occurredAt)) {
    throw new Error('TALENT_TOUCHPOINT_INPUT_INVALID');
  }
  const note = record.note === undefined || record.note === ''
    ? undefined
    : normalizedNote(record.note);
  return Object.freeze({
    kind: record.kind as TouchpointKind,
    channel: record.channel as TouchpointChannel,
    direction: record.direction as TouchpointDirection,
    outcome: record.outcome as TouchpointOutcome,
    occurredAt,
    ...(nextActionAt === undefined ? {} : { nextActionAt }),
    ...(note === undefined ? {} : { note }),
  });
}

function parseSummary(value: unknown): LifecycleSummary {
  const record = objectRecord(value, 'TALENT_LIFECYCLE_SUMMARY_INVALID');
  if (!exactKeys(record, SUMMARY_KEYS)) throw new Error('TALENT_LIFECYCLE_SUMMARY_INVALID');
  return parseSummaryRecord(record);
}

function parseSummaryRecord(record: Readonly<Record<string, unknown>>): LifecycleSummary {
  if (
    typeof record.candidateId !== 'string' || !ULID_PATTERN.test(record.candidateId) ||
    !nullableText(record.displayName, 128) ||
    typeof record.stage !== 'string' || !STAGES.has(record.stage as LifecycleStage) ||
    typeof record.candidateStatus !== 'string' || !CANDIDATE_STATUSES.has(record.candidateStatus) ||
    !nullableEnum(record.currentApplicationStage, APPLICATION_STAGES) ||
    !nullableText(record.currentPositionTitle, 256) ||
    !nullableEnum(record.employeeStatus, EMPLOYEE_STATUSES) ||
    !nullableEnum(record.activeCareStatus, CARE_STATUSES) ||
    !nullableEnum(record.alumniConsentStatus, CONSENT_STATUSES) ||
    !nonnegativeInteger(record.openFollowUpCount) ||
    !nullableIso(record.nextActionAt) ||
    typeof record.updatedAt !== 'string' || !strictIso(record.updatedAt)
  ) throw new Error('TALENT_LIFECYCLE_SUMMARY_INVALID');
  return Object.freeze({
    candidateId: record.candidateId,
    displayName: record.displayName as string | null,
    stage: record.stage as LifecycleStage,
    candidateStatus: record.candidateStatus as LifecycleSummary['candidateStatus'],
    currentApplicationStage: record.currentApplicationStage as string | null,
    currentPositionTitle: record.currentPositionTitle as string | null,
    employeeStatus: record.employeeStatus as string | null,
    activeCareStatus: record.activeCareStatus as string | null,
    alumniConsentStatus: record.alumniConsentStatus as string | null,
    openFollowUpCount: record.openFollowUpCount as number,
    nextActionAt: record.nextActionAt as string | null,
    updatedAt: record.updatedAt,
  });
}

function parseApplication(value: unknown): LifecycleDetail['applications'][number] {
  const record = objectRecord(value, 'TALENT_LIFECYCLE_APPLICATION_INVALID');
  if (
    !exactKeys(record, ['id', 'positionTitle', 'stage', 'sourceChannel', 'appliedAt']) ||
    typeof record.id !== 'string' || !ULID_PATTERN.test(record.id) ||
    !nonemptyText(record.positionTitle, 256) ||
    typeof record.stage !== 'string' || !APPLICATION_STAGES.has(record.stage) ||
    typeof record.sourceChannel !== 'string' || !CODE_PATTERN.test(record.sourceChannel) ||
    typeof record.appliedAt !== 'string' || !strictIso(record.appliedAt)
  ) throw new Error('TALENT_LIFECYCLE_APPLICATION_INVALID');
  return Object.freeze({
    id: record.id,
    positionTitle: record.positionTitle as string,
    stage: record.stage,
    sourceChannel: record.sourceChannel,
    appliedAt: record.appliedAt,
  });
}

function parseOnboarding(value: unknown): LifecycleDetail['onboarding'][number] {
  const record = objectRecord(value, 'TALENT_LIFECYCLE_ONBOARDING_INVALID');
  if (
    !exactKeys(record, ['id', 'status', 'proposedStartDate']) ||
    typeof record.id !== 'string' || !ULID_PATTERN.test(record.id) ||
    typeof record.status !== 'string' || !ONBOARDING_STATUSES.has(record.status) ||
    typeof record.proposedStartDate !== 'string' || !validDate(record.proposedStartDate)
  ) throw new Error('TALENT_LIFECYCLE_ONBOARDING_INVALID');
  return Object.freeze({
    id: record.id,
    status: record.status,
    proposedStartDate: record.proposedStartDate,
  });
}

function parseEmployment(value: unknown): LifecycleDetail['employments'][number] {
  const record = objectRecord(value, 'TALENT_LIFECYCLE_EMPLOYMENT_INVALID');
  if (
    !exactKeys(record, [
      'id', 'employeeNo', 'displayName', 'status', 'effectiveFrom', 'effectiveTo',
    ]) ||
    typeof record.id !== 'string' || !ULID_PATTERN.test(record.id) ||
    typeof record.employeeNo !== 'string' || !CODE_PATTERN.test(record.employeeNo) ||
    !nonemptyText(record.displayName, 128) ||
    typeof record.status !== 'string' || !EMPLOYMENT_STATUSES.has(record.status) ||
    typeof record.effectiveFrom !== 'string' || !validDate(record.effectiveFrom) ||
    !nullableDate(record.effectiveTo)
  ) throw new Error('TALENT_LIFECYCLE_EMPLOYMENT_INVALID');
  return Object.freeze({
    id: record.id,
    employeeNo: record.employeeNo,
    displayName: record.displayName as string,
    status: record.status,
    effectiveFrom: record.effectiveFrom,
    effectiveTo: record.effectiveTo as string | null,
  });
}

function parseCare(value: unknown): LifecycleDetail['care'] {
  const record = objectRecord(value, 'TALENT_LIFECYCLE_CARE_INVALID');
  if (
    !exactKeys(record, ['cases', 'alumniConsents']) ||
    !Array.isArray(record.cases) || record.cases.length > 100 ||
    !Array.isArray(record.alumniConsents) || record.alumniConsents.length > 100
  ) throw new Error('TALENT_LIFECYCLE_CARE_INVALID');
  return Object.freeze({
    cases: Object.freeze(record.cases.map((item) => {
      const careCase = objectRecord(item, 'TALENT_LIFECYCLE_CARE_CASE_INVALID');
      if (
        !exactKeys(careCase, ['id', 'status', 'lastWorkingDate']) ||
        typeof careCase.id !== 'string' || !ULID_PATTERN.test(careCase.id) ||
        typeof careCase.status !== 'string' || !CARE_STATUSES.has(careCase.status) ||
        typeof careCase.lastWorkingDate !== 'string' || !validDate(careCase.lastWorkingDate)
      ) throw new Error('TALENT_LIFECYCLE_CARE_CASE_INVALID');
      return Object.freeze({
        id: careCase.id,
        status: careCase.status,
        lastWorkingDate: careCase.lastWorkingDate,
      });
    })),
    alumniConsents: Object.freeze(record.alumniConsents.map((item) => {
      const consent = objectRecord(item, 'TALENT_LIFECYCLE_CONSENT_INVALID');
      if (
        !exactKeys(consent, ['id', 'purpose', 'status', 'expiresAt']) ||
        typeof consent.id !== 'string' || !ULID_PATTERN.test(consent.id) ||
        typeof consent.purpose !== 'string' || !CONSENT_PURPOSES.has(consent.purpose) ||
        typeof consent.status !== 'string' || !CONSENT_STATUSES.has(consent.status) ||
        typeof consent.expiresAt !== 'string' || !strictIso(consent.expiresAt)
      ) throw new Error('TALENT_LIFECYCLE_CONSENT_INVALID');
      return Object.freeze({
        id: consent.id,
        purpose: consent.purpose,
        status: consent.status,
        expiresAt: consent.expiresAt,
      });
    })),
  });
}

function parseTouchpoint(value: unknown, withNote = true): Touchpoint {
  const record = objectRecord(value, 'TALENT_TOUCHPOINT_INVALID');
  if (
    !exactKeys(record, withNote ? TOUCHPOINT_KEYS : TOUCHPOINT_MUTATION_KEYS) ||
    typeof record.id !== 'string' || !ULID_PATTERN.test(record.id) ||
    typeof record.candidateId !== 'string' || !ULID_PATTERN.test(record.candidateId) ||
    typeof record.kind !== 'string' || !TOUCHPOINT_KINDS.has(record.kind as TouchpointKind) ||
    typeof record.channel !== 'string' ||
    !TOUCHPOINT_CHANNELS.has(record.channel as TouchpointChannel) ||
    typeof record.direction !== 'string' ||
    !TOUCHPOINT_DIRECTIONS.has(record.direction as TouchpointDirection) ||
    typeof record.outcome !== 'string' ||
    !TOUCHPOINT_OUTCOMES.has(record.outcome as TouchpointOutcome) ||
    typeof record.ownerActorId !== 'string' || !IDENTIFIER_PATTERN.test(record.ownerActorId) ||
    typeof record.occurredAt !== 'string' || !strictIso(record.occurredAt) ||
    !nullableIso(record.nextActionAt) ||
    typeof record.status !== 'string' ||
    !TOUCHPOINT_STATUSES.has(record.status as Touchpoint['status']) ||
    (withNote && !nullableText(record.note, 1_000)) ||
    !positiveInteger(record.version)
  ) throw new Error('TALENT_TOUCHPOINT_INVALID');
  return Object.freeze({
    id: record.id,
    candidateId: record.candidateId,
    kind: record.kind as TouchpointKind,
    channel: record.channel as TouchpointChannel,
    direction: record.direction as TouchpointDirection,
    outcome: record.outcome as TouchpointOutcome,
    ownerActorId: record.ownerActorId,
    occurredAt: record.occurredAt,
    nextActionAt: record.nextActionAt as string | null,
    status: record.status as Touchpoint['status'],
    note: withNote ? record.note as string | null : null,
    version: record.version as number,
  });
}

function parseTimelineEntry(value: unknown): TimelineEntry {
  const record = objectRecord(value, 'TALENT_LIFECYCLE_TIMELINE_INVALID');
  if (
    !exactKeys(record, [
      'id', 'domain', 'eventType', 'title', 'occurredAt', 'referenceType', 'referenceId',
    ]) ||
    typeof record.id !== 'string' || record.id.length < 1 || record.id.length > 256 ||
    typeof record.domain !== 'string' ||
    !TIMELINE_DOMAINS.has(record.domain as TimelineEntry['domain']) ||
    typeof record.eventType !== 'string' || !CODE_PATTERN.test(record.eventType) ||
    !nonemptyText(record.title, 256) ||
    typeof record.occurredAt !== 'string' || !strictIso(record.occurredAt) ||
    typeof record.referenceType !== 'string' || !CODE_PATTERN.test(record.referenceType) ||
    typeof record.referenceId !== 'string' || !IDENTIFIER_PATTERN.test(record.referenceId)
  ) throw new Error('TALENT_LIFECYCLE_TIMELINE_INVALID');
  return Object.freeze({
    id: record.id,
    domain: record.domain as TimelineEntry['domain'],
    eventType: record.eventType,
    title: record.title as string,
    occurredAt: record.occurredAt,
    referenceType: record.referenceType,
    referenceId: record.referenceId,
  });
}

function objectRecord(value: unknown, code: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(code);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(code);
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(record: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}

function allowedKeys(record: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

function strictIso(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function nullableIso(value: unknown): boolean {
  return value === null || (typeof value === 'string' && strictIso(value));
}

function nullableUlid(value: unknown): boolean {
  return value === null || (typeof value === 'string' && ULID_PATTERN.test(value));
}

function nonnegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function positiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nullableText(value: unknown, maximum: number): boolean {
  return value === null || nonemptyText(value, maximum);
}

function nonemptyText(value: unknown, maximum: number): boolean {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

function nullableEnum(value: unknown, allowed: ReadonlySet<string>): boolean {
  return value === null || (typeof value === 'string' && allowed.has(value));
}

function nullableDate(value: unknown): boolean {
  return value === null || (typeof value === 'string' && validDate(value));
}

function validDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function canonicalInputInstant(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('TALENT_TOUCHPOINT_INPUT_INVALID');
  return parsed.toISOString();
}

function normalizedNote(value: unknown): string {
  if (typeof value !== 'string') throw new Error('TALENT_TOUCHPOINT_INPUT_INVALID');
  const normalized = value.normalize('NFKC').trim();
  if (normalized.length < 1 || normalized.length > 1_000) {
    throw new Error('TALENT_TOUCHPOINT_INPUT_INVALID');
  }
  return normalized;
}

function uniqueById(values: readonly { readonly id: string }[]): boolean {
  return new Set(values.map((value) => value.id)).size === values.length;
}
