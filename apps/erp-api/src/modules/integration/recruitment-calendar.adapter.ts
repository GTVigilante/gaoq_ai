import { ULID_PATTERN } from '@gaoq/shared-utils';

export type RecruitmentCalendarChannel = 'dingtalk' | 'feishu';

const INTERNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPAQUE_ID_PATTERN = /^[\x21-\x7E]{1,512}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{8,256}$/;
const UTC_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_ATTENDEES = 100;

export interface UpsertRecruitmentCalendarCommand {
  readonly tenantId: string;
  readonly interviewId: string;
  readonly version: number;
  readonly externalCalendarId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timezone: string;
  readonly organizerExternalId: string;
  readonly attendeeExternalIds: readonly string[];
  readonly location: string;
  readonly currentExternalEventId: string | null;
  readonly idempotencyKey: string;
}

export interface CancelRecruitmentCalendarCommand {
  readonly tenantId: string;
  readonly interviewId: string;
  readonly version: number;
  readonly externalCalendarId: string;
  readonly organizerExternalId: string;
  readonly externalEventId: string;
  readonly idempotencyKey: string;
}

export interface RecruitmentCalendarResult {
  readonly externalEventId: string;
  readonly requestId?: string;
}

export type RecruitmentCalendarFailureCategory = 'retryable' | 'business' | 'conflict';

/** 日历适配器只接收标准命令，禁止接收领域对象、平台 Token 或候选人资料。 */
export abstract class RecruitmentCalendarAdapter {
  abstract readonly channel: RecruitmentCalendarChannel;

  abstract upsert(
    command: UpsertRecruitmentCalendarCommand,
  ): Promise<RecruitmentCalendarResult>;

  abstract cancel(
    command: CancelRecruitmentCalendarCommand,
  ): Promise<RecruitmentCalendarResult>;
}

export class RecruitmentCalendarError extends Error {
  constructor(
    readonly code: string,
    readonly category: RecruitmentCalendarFailureCategory,
    message: string,
    readonly status?: number,
    /** 平台可能已提交副作用时仅保存可验证的外部事件标识，不保存响应正文。 */
    readonly externalEventId?: string,
  ) {
    super(message);
    this.name = 'RecruitmentCalendarError';
  }
}

/** 适配器入口必须重新验证标准命令，不能仅信任调用方 TypeScript 类型。 */
export function assertUpsertRecruitmentCalendarCommand(
  command: UpsertRecruitmentCalendarCommand,
): void {
  const attendees = command.attendeeExternalIds;
  if (
    !INTERNAL_ID_PATTERN.test(command.tenantId) ||
    !ULID_PATTERN.test(command.interviewId) ||
    !Number.isSafeInteger(command.version) ||
    command.version < 1 ||
    !opaqueCalendarId(command.externalCalendarId) ||
    !canonicalUtcInstant(command.startsAt) ||
    !canonicalUtcInstant(command.endsAt) ||
    Date.parse(command.endsAt) <= Date.parse(command.startsAt) ||
    !ianaTimeZone(command.timezone) ||
    !opaqueCalendarId(command.organizerExternalId) ||
    !Array.isArray(attendees) ||
    attendees.length < 1 ||
    attendees.length > MAX_ATTENDEES ||
    attendees.some((item) => !opaqueCalendarId(item)) ||
    new Set(attendees).size !== attendees.length ||
    attendees[0] !== command.organizerExternalId ||
    !safeLocation(command.location) ||
    (command.currentExternalEventId !== null &&
      !opaqueCalendarId(command.currentExternalEventId)) ||
    !IDEMPOTENCY_KEY_PATTERN.test(command.idempotencyKey)
  ) {
    throw new RecruitmentCalendarError(
      'CALENDAR_COMMAND_INVALID',
      'business',
      '招聘日历写入命令无效',
    );
  }
}

/** 取消命令同样在平台边界失败关闭。 */
export function assertCancelRecruitmentCalendarCommand(
  command: CancelRecruitmentCalendarCommand,
): void {
  if (
    !INTERNAL_ID_PATTERN.test(command.tenantId) ||
    !ULID_PATTERN.test(command.interviewId) ||
    !Number.isSafeInteger(command.version) ||
    command.version < 1 ||
    !opaqueCalendarId(command.externalCalendarId) ||
    !opaqueCalendarId(command.organizerExternalId) ||
    !opaqueCalendarId(command.externalEventId) ||
    !IDEMPOTENCY_KEY_PATTERN.test(command.idempotencyKey)
  ) {
    throw new RecruitmentCalendarError(
      'CALENDAR_COMMAND_INVALID',
      'business',
      '招聘日历取消命令无效',
    );
  }
}

export function assertRecruitmentCalendarExternalEventId(value: string): string {
  if (!opaqueCalendarId(value)) {
    throw new RecruitmentCalendarError(
      'CALENDAR_EXTERNAL_EVENT_ID_INVALID',
      'conflict',
      '日历平台已响应但外部事件标识无效',
    );
  }
  return value;
}

function opaqueCalendarId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID_PATTERN.test(value);
}

function safeLocation(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 512 &&
    !hasControlCharacter(value);
}

function canonicalUtcInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !UTC_INSTANT_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function ianaTimeZone(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 64 ||
    hasControlCharacter(value)
  ) return false;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value })
      .resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}

export const DINGTALK_RECRUITMENT_CALENDAR_ADAPTER = Symbol(
  'DINGTALK_RECRUITMENT_CALENDAR_ADAPTER',
);
export const FEISHU_RECRUITMENT_CALENDAR_ADAPTER = Symbol(
  'FEISHU_RECRUITMENT_CALENDAR_ADAPTER',
);

export class RecruitmentCalendarAdapterRegistry {
  private readonly adapters: ReadonlyMap<RecruitmentCalendarChannel, RecruitmentCalendarAdapter>;

  constructor(dingtalk: RecruitmentCalendarAdapter, feishu: RecruitmentCalendarAdapter) {
    if (dingtalk.channel !== 'dingtalk' || feishu.channel !== 'feishu') {
      throw new Error('日历适配器渠道装配错误');
    }
    this.adapters = new Map([
      ['dingtalk', dingtalk],
      ['feishu', feishu],
    ]);
  }

  get(channel: RecruitmentCalendarChannel): RecruitmentCalendarAdapter {
    const adapter = this.adapters.get(channel);
    if (adapter === undefined) throw new Error(`日历适配器未装配：${channel}`);
    return adapter;
  }
}
