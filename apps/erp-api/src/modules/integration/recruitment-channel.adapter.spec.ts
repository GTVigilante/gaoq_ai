import { describe, expect, it } from 'vitest';

import {
  RecruitmentChannelAdapter,
  RecruitmentChannelEvidenceVerifier,
  RecruitmentChannelNormalizer,
  RecruitmentChannelRegistry,
} from './recruitment-channel.adapter.js';

class Adapter extends RecruitmentChannelAdapter {
  readonly channelCode = 'sandbox_ats';
  publishPosition() { return Promise.resolve({ externalPositionId: 'p-1', receiptId: 'r-1' }); }
  closePosition() { return Promise.resolve({ receiptId: 'r-2' }); }
  pullApplications() {
    return Promise.resolve({ deliveries: [], nextCursor: null, hasMore: false });
  }
  acknowledgeStage() { return Promise.resolve({ receiptId: 'r-3' }); }
}

class Normalizer extends RecruitmentChannelNormalizer {
  readonly channelCode = 'sandbox_ats';
  readonly schemaVersion = 'v1';
  normalize() { return Promise.reject(new Error('本测试不执行标准化')); }
}

class Verifier extends RecruitmentChannelEvidenceVerifier {
  readonly channelCode = 'sandbox_ats';
  verify() {
    return Promise.resolve({ verified: true, consentEvidenceId: 'consent-1', resumeSnapshotId: null });
  }
}

describe('RecruitmentChannelRegistry', () => {
  it('只有 Adapter、Normalizer 和 EvidenceVerifier 齐备时才完成渠道装配', () => {
    const adapter = new Adapter();
    const normalizer = new Normalizer();
    const verifier = new Verifier();
    const registry = new RecruitmentChannelRegistry([adapter], [normalizer], [verifier]);
    expect(registry.supports('sandbox_ats')).toBe(true);
    expect(registry.adapter('sandbox_ats')).toBe(adapter);
    expect(registry.normalizer('sandbox_ats')).toBe(normalizer);
    expect(registry.verifier('sandbox_ats')).toBe(verifier);
  });

  it('缺失任意一类实现时在启动期失败关闭', () => {
    expect(() => new RecruitmentChannelRegistry(
      [new Adapter()], [new Normalizer()], [],
    )).toThrow('装配不完整');
    const empty = new RecruitmentChannelRegistry([], [], []);
    expect(() => empty.adapter('unknown')).toThrow('未完整装配');
  });

  it('拒绝重复或非白名单渠道编码', () => {
    expect(() => new RecruitmentChannelRegistry(
      [new Adapter(), new Adapter()], [new Normalizer()], [new Verifier()],
    )).toThrow('编码非法或重复');
  });
});
