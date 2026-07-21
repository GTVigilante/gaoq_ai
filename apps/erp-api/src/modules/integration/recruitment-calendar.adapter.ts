export type RecruitmentCalendarChannel = 'dingtalk' | 'feishu';

export interface UpsertRecruitmentCalendarCommand {
  readonly tenantId: string;
  readonly interviewId: string;
  readonly version: number;
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
  ) {
    super(message);
    this.name = 'RecruitmentCalendarError';
  }
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
