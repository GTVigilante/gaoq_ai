import { describe, expect, it } from 'vitest';

import {
  attestPersonBirthdayRequestSchema,
  authorizationCodeTokenRequestSchema,
  eSignIssuanceRequestSchema,
  marketingContentRequestSchema,
  marketingMediaUploadRequestSchema,
  openApiRequestContracts,
  restRequestContracts,
  strictEmptyRequestSchema,
  talentTouchpointCreateRequestSchema,
} from './rest-request-contracts.js';

describe('REST 请求机器契约', () => {
  it('为全部 unknown 运行时入口提供唯一命名 Schema', () => {
    const contracts = openApiRequestContracts();
    expect(Object.keys(contracts)).toHaveLength(29);
    expect(new Set(Object.values(contracts).map(({ name }) => name)).size).toBe(29);
    expect(
      Object.values(contracts).every(({ schema }) =>
        JSON.stringify(schema).includes('"additionalProperties":false'),
      ),
    ).toBe(true);
    expect(
      Object.values(contracts).every(({ schema }) => schema.$schema === undefined),
    ).toBe(true);
  });

  it('拒绝未登记字段和空请求体伪装', () => {
    expect(strictEmptyRequestSchema.safeParse({}).success).toBe(true);
    expect(strictEmptyRequestSchema.safeParse({ tenantId: 'forged' }).success).toBe(false);
    expect(
      eSignIssuanceRequestSchema.safeParse({
        offerId: '01J8ZQK7V0A2M4N6P8R0T2W4C1',
        providerFileId: 'provider-file-001',
        expiresAt: '2026-08-01T00:00:00.000Z',
        signaturePosition: { page: 1, x: 10, y: 20 },
        tenantId: 'forged',
      }).success,
    ).toBe(false);
  });

  it('覆盖 OAuth 长度边界和授权码必填字段', () => {
    const valid = {
      grant_type: 'authorization_code' as const,
      client_id: 'client-001',
      code: 'code-001',
      redirect_uri: 'https://client.example.invalid/callback',
      resource: 'https://erp.example.invalid',
      code_verifier: 'a'.repeat(43),
    };
    expect(authorizationCodeTokenRequestSchema.safeParse(valid).success).toBe(true);
    expect(
      authorizationCodeTokenRequestSchema.safeParse({
        ...valid,
        code_verifier: 'a'.repeat(42),
      }).success,
    ).toBe(false);
  });

  it('覆盖生日与人才触点的规范日期失败关闭', () => {
    expect(
      attestPersonBirthdayRequestSchema.safeParse({
        monthDay: '02-29',
        identityEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4C1',
        birthdayEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4C2',
      }).success,
    ).toBe(true);
    expect(
      attestPersonBirthdayRequestSchema.safeParse({
        monthDay: '02-30',
        identityEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4C1',
        birthdayEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4C2',
      }).success,
    ).toBe(false);
    const touchpoint = {
      kind: 'candidate_outreach' as const,
      channel: 'email' as const,
      direction: 'outbound' as const,
      outcome: 'contacted' as const,
      occurredAt: '2026-08-01T00:00:00.000Z',
    };
    expect(talentTouchpointCreateRequestSchema.safeParse(touchpoint).success).toBe(true);
    expect(
      talentTouchpointCreateRequestSchema.safeParse({
        ...touchpoint,
        occurredAt: '2026-08-01T00:00:00Z',
      }).success,
    ).toBe(false);
  });

  it('覆盖营销内容、文件类型和大小边界', () => {
    const content = {
      siteId: 'site-001',
      type: 'page' as const,
      locale: 'zh-CN' as const,
      slug: 'about-us',
      title: '关于我们',
      blocks: [],
    };
    expect(marketingContentRequestSchema.safeParse(content).success).toBe(true);
    expect(
      marketingContentRequestSchema.safeParse({
        ...content,
        blocks: Array.from({ length: 41 }, () => ({
          type: 'hero',
          data: {},
        })),
      }).success,
    ).toBe(false);
    const media = {
      siteId: 'site-001',
      fileName: 'hero.png',
      mimeType: 'image/png' as const,
      sizeBytes: 20_971_520,
      altText: { 'zh-CN': '首页主图' },
      copyrightSource: '自有素材',
    };
    expect(marketingMediaUploadRequestSchema.safeParse(media).success).toBe(true);
    expect(
      marketingMediaUploadRequestSchema.safeParse({
        ...media,
        sizeBytes: 20_971_521,
      }).success,
    ).toBe(false);
  });

  it('注册表自身不会向客户端开放租户字段', () => {
    for (const contract of Object.values(restRequestContracts)) {
      const json = JSON.stringify(contract.schema);
      expect(json).not.toContain('tenantId');
    }
  });
});
