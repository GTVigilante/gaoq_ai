import { ServiceUnavailableException } from '@nestjs/common';

export const RECRUITMENT_CHANNEL_ADAPTERS = Symbol('RECRUITMENT_CHANNEL_ADAPTERS');
export const RECRUITMENT_CHANNEL_NORMALIZERS = Symbol('RECRUITMENT_CHANNEL_NORMALIZERS');
export const RECRUITMENT_CHANNEL_EVIDENCE_VERIFIERS = Symbol(
  'RECRUITMENT_CHANNEL_EVIDENCE_VERIFIERS',
);

export type RecruitmentChannelStage =
  | 'applied' | 'screening' | 'interview' | 'offer' | 'hired' | 'rejected' | 'withdrawn';

export interface RecruitmentChannelPositionCommand {
  readonly tenantId: string;
  readonly positionId: string;
  readonly title: string;
  readonly departmentCode: string;
  readonly location: string;
  readonly headcount: number;
  readonly idempotencyKey: string;
}

export interface RecruitmentChannelRawDelivery {
  readonly externalEventId: string;
  readonly occurredAt: string;
  readonly payload: unknown;
}

export interface RecruitmentChannelPullResult {
  readonly deliveries: readonly RecruitmentChannelRawDelivery[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/** 供应商 Adapter 只负责传输，不直接访问 ERP 数据库或改写招聘状态。 */
export abstract class RecruitmentChannelAdapter {
  abstract readonly channelCode: string;

  abstract publishPosition(
    credential: string,
    command: RecruitmentChannelPositionCommand,
  ): Promise<{ readonly externalPositionId: string; readonly receiptId: string }>;

  abstract closePosition(
    credential: string,
    input: { readonly externalPositionId: string; readonly idempotencyKey: string },
  ): Promise<{ readonly receiptId: string }>;

  abstract pullApplications(
    credential: string,
    input: {
      readonly tenantId: string;
      readonly cursor: string | null;
      readonly limit: number;
    },
  ): Promise<RecruitmentChannelPullResult>;

  abstract acknowledgeStage(
    credential: string,
    input: {
      readonly externalApplicationId: string;
      readonly stage: RecruitmentChannelStage;
      readonly idempotencyKey: string;
    },
  ): Promise<{ readonly receiptId: string }>;
}

export interface NormalizedRecruitmentChannelApplication {
  readonly externalPositionId: string;
  readonly externalCandidateId: string;
  readonly externalApplicationId: string;
  readonly candidate: {
    readonly name: string;
    readonly phone?: string;
    readonly email?: string;
  };
  readonly consent: {
    readonly version: string;
    readonly purpose: string;
    readonly expiresAt: string;
    readonly retentionExpiresAt: string;
  };
  /** 只允许供应商不可解释附件引用，不得放入下载 URL 或 Token。 */
  readonly attachmentReferences: readonly string[];
}

/** 标准化与传输 Adapter 分离，便于固定样本回放和版本治理。 */
export abstract class RecruitmentChannelNormalizer {
  abstract readonly channelCode: string;
  abstract readonly schemaVersion: string;
  abstract normalize(payload: unknown): Promise<NormalizedRecruitmentChannelApplication>;
}

/** 附件扫描、WORM 归档与授权真实性校验端口；未装配时必须失败关闭。 */
export abstract class RecruitmentChannelEvidenceVerifier {
  abstract readonly channelCode: string;
  abstract verify(input: {
    readonly tenantId: string;
    readonly inboxId: string;
    readonly application: NormalizedRecruitmentChannelApplication;
  }): Promise<{
    readonly verified: boolean;
    readonly consentEvidenceId: string;
    readonly resumeSnapshotId: string | null;
  }>;
}

export class RecruitmentChannelRegistry {
  private readonly adapters: ReadonlyMap<string, RecruitmentChannelAdapter>;
  private readonly normalizers: ReadonlyMap<string, RecruitmentChannelNormalizer>;
  private readonly verifiers: ReadonlyMap<string, RecruitmentChannelEvidenceVerifier>;

  constructor(
    adapters: readonly RecruitmentChannelAdapter[],
    normalizers: readonly RecruitmentChannelNormalizer[],
    verifiers: readonly RecruitmentChannelEvidenceVerifier[],
  ) {
    this.adapters = indexed(adapters, 'Adapter');
    this.normalizers = indexed(normalizers, 'Normalizer');
    this.verifiers = indexed(verifiers, 'EvidenceVerifier');
    const codes = new Set([
      ...this.adapters.keys(), ...this.normalizers.keys(), ...this.verifiers.keys(),
    ]);
    for (const code of codes) {
      if (
        !this.adapters.has(code) || !this.normalizers.has(code) || !this.verifiers.has(code)
      ) throw new Error(`招聘渠道装配不完整：${code}`);
    }
  }

  adapter(code: string): RecruitmentChannelAdapter {
    return this.adapters.get(code) ?? unavailable(code);
  }

  normalizer(code: string): RecruitmentChannelNormalizer {
    return this.normalizers.get(code) ?? unavailable(code);
  }

  verifier(code: string): RecruitmentChannelEvidenceVerifier {
    return this.verifiers.get(code) ?? unavailable(code);
  }

  supports(code: string): boolean {
    return this.adapters.has(code);
  }
}

function indexed<T extends { readonly channelCode: string }>(
  values: readonly T[],
  kind: string,
): ReadonlyMap<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    if (!/^[a-z][a-z0-9_]{1,31}$/.test(value.channelCode) || result.has(value.channelCode)) {
      throw new Error(`招聘渠道 ${kind} 编码非法或重复`);
    }
    result.set(value.channelCode, value);
  }
  return result;
}

function unavailable<T>(channelCode: string): T {
  throw new ServiceUnavailableException({
    code: 'RECRUITMENT_CHANNEL_UNAVAILABLE',
    message: `招聘渠道 ${channelCode} 未完整装配`,
  });
}
