import { describe, expect, it } from 'vitest';

import { parseSsoCallbackInput, parseSsoCompletion } from './sso-browser-contract';

describe('浏览器 SSO 回调契约', () => {
  it('接受钉钉 authCode 并只返回最小字段', () => {
    expect(parseSsoCallbackInput(
      'dingtalk',
      new URLSearchParams({ state: 'A'.repeat(43), authCode: 'one-time-code' }),
    )).toEqual({ provider: 'dingtalk', state: 'A'.repeat(43), code: 'one-time-code' });
  });

  it('拒绝重复 code/state、未知平台与畸形 state', () => {
    expect(() => parseSsoCallbackInput(
      'dingtalk',
      new URLSearchParams(`state=${'A'.repeat(43)}&code=a&authCode=b`),
    )).toThrow('SSO_CALLBACK_INVALID');
    expect(() => parseSsoCallbackInput(
      'dingtalk',
      new URLSearchParams(`state=${'A'.repeat(43)}&state=${'B'.repeat(43)}&code=a`),
    )).toThrow('SSO_CALLBACK_INVALID');
    expect(() => parseSsoCallbackInput(
      'custom', new URLSearchParams({ state: 'A'.repeat(43), code: 'a' }),
    )).toThrow('SSO_PROVIDER_INVALID');
    expect(() => parseSsoCallbackInput(
      'dingtalk', new URLSearchParams({ state: 'short', code: 'a' }),
    )).toThrow('SSO_CALLBACK_INVALID');
  });

  it('只接受规范站内返回路径', () => {
    expect(parseSsoCompletion({ returnPath: '/workspace/contacts', accessToken: 'ignored' }))
      .toEqual({ returnPath: '/workspace/contacts' });
    for (const returnPath of ['https://evil.example', '//evil.example', '/ok\\evil', '/bad\n']) {
      expect(() => parseSsoCompletion({ returnPath })).toThrow('SSO_COMPLETION_INVALID');
    }
  });
});
