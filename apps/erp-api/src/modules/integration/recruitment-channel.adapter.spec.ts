import { describe, expect, it } from 'vitest';

import {
  RecruitmentChannelAdapter,
  RecruitmentChannelEvidenceVerifier,
  RecruitmentChannelNormalizer,
  RecruitmentChannelRegistry,
  RecruitmentChannelTransportError,
} from './recruitment-channel.adapter.js';

class Adapter extends RecruitmentChannelAdapter {
  constructor(readonly channelCode = 'sandbox_ats') { super(); }
  publishPosition() { return Promise.resolve({ externalPositionId: 'p-1', receiptId: 'r-1' }); }
  closePosition() { return Promise.resolve({ receiptId: 'r-2' }); }
  pullApplications() {
    return Promise.resolve({ deliveries: [], nextCursor: null, hasMore: false });
  }
  acknowledgeStage() { return Promise.resolve({ receiptId: 'r-3' }); }
}

class Normalizer extends RecruitmentChannelNormalizer {
  constructor(readonly channelCode = 'sandbox_ats') { super(); }
  readonly schemaVersion = 'v1';
  normalize() { return Promise.reject(new Error('本测试不执行标准化')); }
}

class Verifier extends RecruitmentChannelEvidenceVerifier {
  constructor(readonly channelCode = 'sandbox_ats') { super(); }
  verify() {
    return Promise.resolve({ verified: true, consentEvidenceId: 'consent-1', resumeSnapshotId: null });
  }
}

describe('RecruitmentChannelRegistry', () => {
  it('传输错误只接受稳定错误码和显式外部提交结论', () => {
    const safe = new RecruitmentChannelTransportError(
      'CHANNEL_RATE_LIMITED',
      'not_committed',
    );
    expect(safe).toMatchObject({
      name: 'RecruitmentChannelTransportError',
      message: 'CHANNEL_RATE_LIMITED',
      code: 'CHANNEL_RATE_LIMITED',
      outcome: 'not_committed',
    });
    expect(() => new RecruitmentChannelTransportError(
      'temporary failure',
      'unknown',
    )).toThrow('传输错误码非法');
  });

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
    expect(() => new RecruitmentChannelRegistry(
      [], [new Normalizer()], [new Verifier()],
    )).toThrow('装配不完整');
    expect(() => new RecruitmentChannelRegistry(
      [new Adapter()], [], [new Verifier()],
    )).toThrow('装配不完整');
    const empty = new RecruitmentChannelRegistry([], [], []);
    expect(() => empty.adapter('unknown')).toThrow('未完整装配');
    expect(() => empty.normalizer('unknown')).toThrow('未完整装配');
    expect(() => empty.verifier('unknown')).toThrow('未完整装配');
    expect(empty.supports('unknown')).toBe(false);
  });

  it.each([
    {
      adapters: [new Adapter(), new Adapter()],
      normalizers: [new Normalizer()],
      verifiers: [new Verifier()],
    },
    {
      adapters: [new Adapter()],
      normalizers: [new Normalizer(), new Normalizer()],
      verifiers: [new Verifier()],
    },
    {
      adapters: [new Adapter()],
      normalizers: [new Normalizer()],
      verifiers: [new Verifier(), new Verifier()],
    },
    {
      adapters: [new Adapter('Bad-Code')],
      normalizers: [new Normalizer('Bad-Code')],
      verifiers: [new Verifier('Bad-Code')],
    },
  ])('拒绝重复或非白名单渠道编码：$adapters', ({ adapters, normalizers, verifiers }) => {
    expect(() => new RecruitmentChannelRegistry(
      adapters, normalizers, verifiers,
    )).toThrow('编码非法或重复');
  });
});
