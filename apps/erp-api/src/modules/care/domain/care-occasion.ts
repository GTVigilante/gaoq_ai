import { createHash } from 'node:crypto';

import { CareDomainError } from './care.js';

export type CareOccasionType = 'birthday' | 'employment_anniversary';
export type CareOccasionChannel = 'email' | 'sms' | 'feishu' | 'dingtalk';
export type CareOccasionTaskStatus =
  | 'pending'
  | 'dispatching'
  | 'delivered'
  | 'cancelled'
  | 'dead';

export interface CareOccasionPolicy {
  readonly version: string;
  readonly timeZone: string;
  readonly dispatchLocalTime: string;
  readonly quietHoursStart: string;
  readonly quietHoursEnd: string;
  readonly leapDayPolicy: 'feb28' | 'mar01';
  readonly rehireAnniversaryBasis: 'current_employment' | 'original_employment';
  readonly birthdayTemplateCode: string;
  readonly anniversaryTemplateCode: string;
  readonly maxAttempts: number;
}

export interface CareOccasionPreference {
  readonly id: string;
  readonly tenantId: string;
  readonly personId: string;
  readonly employeeId: string;
  readonly currentEmploymentId: string;
  readonly birthdayEnabled: boolean;
  readonly anniversaryEnabled: boolean;
  readonly preferredChannels: readonly CareOccasionChannel[];
  readonly unsubscribed: boolean;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CareOccasionTask {
  readonly id: string;
  readonly tenantId: string;
  readonly personId: string;
  readonly employeeId: string;
  readonly employmentId: string;
  readonly occasionType: CareOccasionType;
  readonly occurrenceYear: number;
  readonly scheduledAt: string;
  readonly templateCode: string;
  readonly policyVersion: string;
  readonly preferredChannels: readonly CareOccasionChannel[];
  readonly sourceDigest: string;
  readonly status: CareOccasionTaskStatus;
  readonly attempts: number;
  readonly nextAttemptAt: string;
  readonly lockedAt: string | null;
  readonly lockedBy: string | null;
  readonly denialCode: string | null;
  readonly deliveryEvidenceId: string | null;
  readonly deliveredAt: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CareOccasionSourceFacts {
  readonly personId: string;
  readonly employeeId: string;
  readonly currentEmploymentId: string;
  readonly birthdayMonthDay: string | null;
  /** 生日盲索引版本摘要；仅用于检测权威事实变更，不可逆推出生日。 */
  readonly birthdaySourceRevision?: string | null;
  readonly currentEmploymentEffectiveFrom: string;
  readonly employmentEffectiveFromDates: readonly string[];
}

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LOCAL_TIME_PATTERN = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
const CHANNELS = new Set<CareOccasionChannel>(['email', 'sms', 'feishu', 'dingtalk']);

export function validateCareOccasionPolicy(policy: CareOccasionPolicy): CareOccasionPolicy {
  if (!CODE_PATTERN.test(policy.version)) invalid('CARE_OCCASION_POLICY_INVALID', '关怀策略版本非法');
  assertTimeZone(policy.timeZone);
  const dispatch = localMinutes(policy.dispatchLocalTime, 'dispatchLocalTime');
  const quietStart = localMinutes(policy.quietHoursStart, 'quietHoursStart');
  const quietEnd = localMinutes(policy.quietHoursEnd, 'quietHoursEnd');
  if (inQuietHours(dispatch, quietStart, quietEnd)) invalid(
    'CARE_OCCASION_POLICY_QUIET_HOURS_CONFLICT',
    '关怀发送时间不能落在静默时段',
  );
  if (
    !CODE_PATTERN.test(policy.birthdayTemplateCode) ||
    !CODE_PATTERN.test(policy.anniversaryTemplateCode)
  ) invalid('CARE_OCCASION_TEMPLATE_INVALID', '关怀模板编码非法');
  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > 12) {
    invalid('CARE_OCCASION_POLICY_INVALID', '关怀最大尝试次数必须为 1..12');
  }
  return Object.freeze({ ...policy });
}

export function createCareOccasionPreference(
  input: {
    readonly id: string;
    readonly tenantId: string;
    readonly personId: string;
    readonly employeeId: string;
    readonly currentEmploymentId: string;
    readonly birthdayEnabled: boolean;
    readonly anniversaryEnabled: boolean;
    readonly preferredChannels: readonly CareOccasionChannel[];
    readonly unsubscribed: boolean;
  },
  now: Date,
): CareOccasionPreference {
  assertIds(input, ['id', 'tenantId', 'personId', 'employeeId', 'currentEmploymentId']);
  const channels = normalizeChannels(input.preferredChannels);
  if (
    !input.unsubscribed &&
    (input.birthdayEnabled || input.anniversaryEnabled) &&
    channels.length === 0
  ) invalid('CARE_OCCASION_CHANNEL_REQUIRED', '启用关怀时必须选择至少一个偏好渠道');
  const occurredAt = iso(now);
  return Object.freeze({
    ...input,
    birthdayEnabled: input.unsubscribed ? false : input.birthdayEnabled,
    anniversaryEnabled: input.unsubscribed ? false : input.anniversaryEnabled,
    preferredChannels: input.unsubscribed ? Object.freeze([]) : channels,
    version: 1,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
}

export function updateCareOccasionPreference(
  preference: CareOccasionPreference,
  input: {
    readonly tenantId: string;
    readonly expectedVersion: number;
    readonly currentEmploymentId: string;
    readonly birthdayEnabled: boolean;
    readonly anniversaryEnabled: boolean;
    readonly preferredChannels: readonly CareOccasionChannel[];
    readonly unsubscribeAll: boolean;
  },
  now: Date,
): CareOccasionPreference {
  if (preference.tenantId !== input.tenantId) invalid(
    'CARE_CROSS_TENANT',
    '禁止跨租户修改关怀偏好',
  );
  if (preference.version !== input.expectedVersion) invalid(
    'CARE_VERSION_CONFLICT',
    '关怀偏好版本冲突',
  );
  assertId(input.currentEmploymentId, 'currentEmploymentId');
  const channels = normalizeChannels(input.preferredChannels);
  if (
    !input.unsubscribeAll &&
    (input.birthdayEnabled || input.anniversaryEnabled) &&
    channels.length === 0
  ) invalid('CARE_OCCASION_CHANNEL_REQUIRED', '启用关怀时必须选择至少一个偏好渠道');
  return Object.freeze({
    ...preference,
    currentEmploymentId: input.currentEmploymentId,
    birthdayEnabled: input.unsubscribeAll ? false : input.birthdayEnabled,
    anniversaryEnabled: input.unsubscribeAll ? false : input.anniversaryEnabled,
    preferredChannels: input.unsubscribeAll ? Object.freeze([]) : channels,
    unsubscribed: input.unsubscribeAll,
    version: preference.version + 1,
    updatedAt: iso(now),
  });
}

export function planCareOccasionTasks(
  input: {
    readonly tenantId: string;
    readonly source: CareOccasionSourceFacts;
    readonly preference: CareOccasionPreference;
    readonly policy: CareOccasionPolicy;
    readonly now: Date;
    readonly createId: (scheduledAt: Date, occasionType: CareOccasionType) => string;
  },
): readonly CareOccasionTask[] {
  const policy = validateCareOccasionPolicy(input.policy);
  if (
    input.preference.tenantId !== input.tenantId ||
    input.preference.employeeId !== input.source.employeeId ||
    input.preference.personId !== input.source.personId ||
    input.preference.currentEmploymentId !== input.source.currentEmploymentId
  ) invalid('CARE_OCCASION_SOURCE_MISMATCH', '关怀偏好与权威主数据不一致');
  if (input.preference.unsubscribed) return Object.freeze([]);
  const tasks: CareOccasionTask[] = [];
  if (input.preference.birthdayEnabled && input.source.birthdayMonthDay !== null) {
    const scheduledAt = nextAnnualInstant(
      input.source.birthdayMonthDay,
      input.now,
      policy.timeZone,
      policy.dispatchLocalTime,
      policy.leapDayPolicy,
    );
    tasks.push(createTask({
      tenantId: input.tenantId,
      source: input.source,
      preference: input.preference,
      policy,
      occasionType: 'birthday',
      scheduledAt,
      templateCode: policy.birthdayTemplateCode,
      createId: input.createId,
      createdAt: input.now,
    }));
  }
  if (input.preference.anniversaryEnabled) {
    const effectiveFrom = policy.rehireAnniversaryBasis === 'current_employment'
      ? input.source.currentEmploymentEffectiveFrom
      : [...input.source.employmentEffectiveFromDates].sort()[0];
    if (effectiveFrom === undefined) invalid(
      'CARE_OCCASION_EMPLOYMENT_SOURCE_MISSING',
      '关怀主数据缺少劳动关系生效日期',
    );
    const scheduledAt = nextAnnualInstant(
      effectiveFrom.slice(5),
      input.now,
      policy.timeZone,
      policy.dispatchLocalTime,
      policy.leapDayPolicy,
    );
    tasks.push(createTask({
      tenantId: input.tenantId,
      source: input.source,
      preference: input.preference,
      policy,
      occasionType: 'employment_anniversary',
      scheduledAt,
      templateCode: policy.anniversaryTemplateCode,
      createId: input.createId,
      createdAt: input.now,
    }));
  }
  return Object.freeze(tasks);
}

export function markCareOccasionDispatching(
  task: CareOccasionTask,
  workerId: string,
  now: Date,
): CareOccasionTask {
  assertId(workerId, 'workerId');
  if (task.status !== 'pending' || Date.parse(task.nextAttemptAt) > now.getTime()) invalid(
    'CARE_OCCASION_TASK_NOT_DUE',
    '关怀任务尚不可投递',
  );
  return Object.freeze({
    ...task,
    status: 'dispatching',
    attempts: task.attempts + 1,
    lockedAt: iso(now),
    lockedBy: workerId,
    version: task.version + 1,
    updatedAt: iso(now),
  });
}

export function completeCareOccasionTask(
  task: CareOccasionTask,
  input:
    | {
        readonly outcome: 'delivered';
        readonly deliveryEvidenceId: string;
        readonly deliveredAt: string;
      }
    | {
        readonly outcome: 'denied';
        readonly denialCode:
          | 'unsubscribed'
          | 'no_authorized_channel'
          | 'purpose_restricted'
          | 'quiet_hours';
      },
  now: Date,
): CareOccasionTask {
  if (task.status !== 'dispatching') invalid(
    'CARE_OCCASION_TASK_NOT_DISPATCHING',
    '关怀任务不在投递状态',
  );
  if (input.outcome === 'delivered') {
    assertId(input.deliveryEvidenceId, 'deliveryEvidenceId');
    const deliveredAt = canonicalInstant(input.deliveredAt, 'deliveredAt');
    if (Date.parse(deliveredAt) < Date.parse(task.scheduledAt) - 5 * 60_000) invalid(
      'CARE_OCCASION_RECEIPT_INVALID',
      '通知送达时间早于允许窗口',
    );
    return Object.freeze({
      ...task,
      status: 'delivered',
      deliveryEvidenceId: input.deliveryEvidenceId,
      deliveredAt,
      lockedAt: null,
      lockedBy: null,
      version: task.version + 1,
      updatedAt: iso(now),
    });
  }
  return Object.freeze({
    ...task,
    status: 'cancelled',
    denialCode: input.denialCode,
    lockedAt: null,
    lockedBy: null,
    version: task.version + 1,
    updatedAt: iso(now),
  });
}

export function releaseCareOccasionTask(
  task: CareOccasionTask,
  maxAttempts: number,
  now: Date,
): CareOccasionTask {
  if (task.status !== 'dispatching') invalid(
    'CARE_OCCASION_TASK_NOT_DISPATCHING',
    '关怀任务不在投递状态',
  );
  const terminal = task.attempts >= maxAttempts;
  const delay = Math.min(6 * 60 * 60_000, 30_000 * 2 ** Math.max(0, task.attempts - 1));
  return Object.freeze({
    ...task,
    status: terminal ? 'dead' : 'pending',
    nextAttemptAt: terminal ? task.nextAttemptAt : new Date(now.getTime() + delay).toISOString(),
    lockedAt: null,
    lockedBy: null,
    version: task.version + 1,
    updatedAt: iso(now),
  });
}

export function careOccasionSourceDigest(input: {
  readonly tenantId: string;
  readonly source: CareOccasionSourceFacts;
  readonly preferenceVersion: number;
  readonly policyVersion: string;
}): string {
  if (!Number.isSafeInteger(input.preferenceVersion) || input.preferenceVersion < 1) {
    invalid('CARE_OCCASION_SOURCE_DIGEST_INVALID', '关怀偏好版本非法');
  }
  const digest = createHash('sha256').update(JSON.stringify([
    'gaoq-care-occasion-source-v1',
    input.tenantId,
    input.source.personId,
    input.source.employeeId,
    input.source.currentEmploymentId,
    input.source.birthdaySourceRevision ?? null,
    input.source.currentEmploymentEffectiveFrom,
    [...input.source.employmentEffectiveFromDates].sort(),
    input.preferenceVersion,
    input.policyVersion,
  ]), 'utf8').digest('base64url');
  if (!DIGEST_PATTERN.test(digest)) invalid(
    'CARE_OCCASION_SOURCE_DIGEST_INVALID',
    '关怀主数据摘要非法',
  );
  return digest;
}

function createTask(input: {
  readonly tenantId: string;
  readonly source: CareOccasionSourceFacts;
  readonly preference: CareOccasionPreference;
  readonly policy: CareOccasionPolicy;
  readonly occasionType: CareOccasionType;
  readonly scheduledAt: Date;
  readonly templateCode: string;
  readonly createId: (scheduledAt: Date, occasionType: CareOccasionType) => string;
  readonly createdAt: Date;
}): CareOccasionTask {
  const id = input.createId(input.scheduledAt, input.occasionType);
  assertId(id, 'id');
  const occurredAt = iso(input.createdAt);
  const sourceDigest = careOccasionSourceDigest({
    tenantId: input.tenantId,
    source: input.source,
    preferenceVersion: input.preference.version,
    policyVersion: input.policy.version,
  });
  return Object.freeze({
    id,
    tenantId: input.tenantId,
    personId: input.source.personId,
    employeeId: input.source.employeeId,
    employmentId: input.source.currentEmploymentId,
    occasionType: input.occasionType,
    occurrenceYear: yearAt(input.scheduledAt, input.policy.timeZone),
    scheduledAt: input.scheduledAt.toISOString(),
    templateCode: input.templateCode,
    policyVersion: input.policy.version,
    preferredChannels: Object.freeze([...input.preference.preferredChannels]),
    sourceDigest,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: input.scheduledAt.toISOString(),
    lockedAt: null,
    lockedBy: null,
    denialCode: null,
    deliveryEvidenceId: null,
    deliveredAt: null,
    version: 1,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
}

function nextAnnualInstant(
  monthDay: string,
  now: Date,
  timeZone: string,
  localTime: string,
  leapDayPolicy: CareOccasionPolicy['leapDayPolicy'],
): Date {
  const currentYear = yearAt(now, timeZone);
  for (const year of [currentYear, currentYear + 1]) {
    const normalized = normalizeBirthdayMonthDay(monthDay, leapDayPolicy, year);
    const candidate = zonedInstant(`${year}-${normalized}`, localTime, timeZone);
    if (candidate.getTime() >= now.getTime()) return candidate;
  }
  throw new CareDomainError('CARE_OCCASION_DATE_INVALID', '无法计算下一次关怀日期');
}

function normalizeBirthdayMonthDay(
  monthDay: string,
  leapDayPolicy: CareOccasionPolicy['leapDayPolicy'],
  year: number,
): string {
  if (!/^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/.test(monthDay)) invalid(
    'CARE_OCCASION_DATE_INVALID',
    '关怀月日格式非法',
  );
  if (monthDay === '02-29' && !isLeapYear(year)) {
    return leapDayPolicy === 'feb28' ? '02-28' : '03-01';
  }
  const date = new Date(`${year}-${monthDay}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(5, 10) !== monthDay) invalid(
    'CARE_OCCASION_DATE_INVALID',
    '关怀月日不是合法日期',
  );
  return monthDay;
}

function zonedInstant(localDate: string, localTime: string, timeZone: string): Date {
  assertTimeZone(timeZone);
  localMinutes(localTime, 'dispatchLocalTime');
  const [year, month, day] = localDate.split('-').map(Number);
  const [hour, minute] = localTime.split(':').map(Number);
  if (
    year === undefined || month === undefined || day === undefined ||
    hour === undefined || minute === undefined
  ) invalid('CARE_OCCASION_DATE_INVALID', '关怀本地时间非法');
  const intended = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = intended;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const parts = zonedParts(new Date(candidate), timeZone);
    const represented = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
    );
    candidate -= represented - intended;
  }
  const result = new Date(candidate);
  const verified = zonedParts(result, timeZone);
  if (
    verified.year !== year ||
    verified.month !== month ||
    verified.day !== day ||
    verified.hour !== hour ||
    verified.minute !== minute
  ) invalid('CARE_OCCASION_DATE_INVALID', '关怀本地时间在目标时区不存在');
  return result;
}

function zonedParts(value: Date, timeZone: string): {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
} {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const result = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
  return {
    year: result.year ?? 0,
    month: result.month ?? 0,
    day: result.day ?? 0,
    hour: result.hour ?? 0,
    minute: result.minute ?? 0,
  };
}

function yearAt(value: Date, timeZone: string): number {
  assertTimeZone(timeZone);
  return zonedParts(value, timeZone).year;
}

function normalizeChannels(
  channels: readonly CareOccasionChannel[],
): readonly CareOccasionChannel[] {
  if (
    channels.length > CHANNELS.size ||
    channels.some((channel) => !CHANNELS.has(channel))
  ) invalid('CARE_OCCASION_CHANNEL_INVALID', '关怀偏好渠道非法');
  return Object.freeze([...new Set(channels)].sort());
}

function localMinutes(value: string, field: string): number {
  const match = LOCAL_TIME_PATTERN.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) invalid(
    'CARE_OCCASION_LOCAL_TIME_INVALID',
    `${field} 必须为 HH:mm`,
  );
  return Number(match[1]) * 60 + Number(match[2]);
}

function inQuietHours(value: number, start: number, end: number): boolean {
  if (start === end) return true;
  return start < end
    ? value >= start && value < end
    : value >= start || value < end;
}

function assertTimeZone(value: string): void {
  if (value.length < 1 || value.length > 64) invalid(
    'CARE_OCCASION_TIME_ZONE_INVALID',
    '关怀租户时区非法',
  );
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value }).format(new Date());
  } catch {
    invalid('CARE_OCCASION_TIME_ZONE_INVALID', '关怀租户时区非法');
  }
}

function assertIds(value: object, fields: readonly string[]): void {
  const record = value as Readonly<Record<string, unknown>>;
  for (const field of fields) assertId(record[field], field);
}

function assertId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) invalid(
    'CARE_ID_INVALID',
    `${field} 非法`,
  );
}

function iso(value: Date): string {
  if (Number.isNaN(value.getTime())) invalid('CARE_OCCASION_DATE_INVALID', '关怀时间非法');
  return value.toISOString();
}

function canonicalInstant(value: string, field: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) invalid(
    'CARE_OCCASION_DATE_INVALID',
    `${field} 必须为规范 UTC 时间`,
  );
  return value;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function invalid(code: string, message: string): never {
  throw new CareDomainError(code, message);
}
