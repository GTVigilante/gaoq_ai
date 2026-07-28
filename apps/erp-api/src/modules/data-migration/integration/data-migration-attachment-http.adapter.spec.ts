import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../../config/environment.js';
import { HttpDataMigrationAttachmentGateway } from './data-migration-attachment-http.adapter.js';

afterEach(() => vi.unstubAllGlobals());

function config(
  overrides: Partial<AppEnvironment> = {},
): ConfigService<AppEnvironment, true> {
  const values: Partial<AppEnvironment> = {
    DATA_MIGRATION_ATTACHMENT_GATEWAY_ENDPOINT: 'https://migration-files.example.test/v1/transfer',
    DATA_MIGRATION_ATTACHMENT_GATEWAY_BEARER_TOKEN: 'secret-token-at-least-thirty-two-characters',
    ...overrides,
  };
  return { get: (key: keyof AppEnvironment) => values[key] } as
    unknown as ConfigService<AppEnvironment, true>;
}

function input() {
  return {
    tenantId: 'tenant-001', runId: '01J8ZQK7V0A2M4N6P8R0T2W4F1',
    sourceSystem: 'legacy-hr', sourceAttachmentId: 'legacy-file-001',
    expectedChecksum: 'c'.repeat(43), retentionDays: 2_555, classification: 'L4' as const,
  };
}

function receipt(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    schemaVersion: 'erp-data-migration-attachment-receipt.v1',
    tenantId: 'tenant-001',
    runId: '01J8ZQK7V0A2M4N6P8R0T2W4F1',
    sourceSystem: 'legacy-hr',
    sourceAttachmentId: 'legacy-file-001',
    targetEvidenceId: 'worm/migration/file-001',
    malwareScanEvidenceId: 'scan-001',
    checksum: 'c'.repeat(43),
    immutable: true,
    malwareClean: true,
    retentionDays: 2_555,
    classification: 'L4',
    ...overrides,
  };
}

describe('数据迁移附件隔离网关', () => {
  it('只发送控制标识并严格校验扫描与不可变归档回执', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify(receipt()),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new HttpDataMigrationAttachmentGateway(config()).transfer(input());

    expect(result).toMatchObject({
      targetEvidenceId: 'worm/migration/file-001', malwareClean: true, immutable: true,
      classification: 'L4',
    });
    const request = fetchMock.mock.calls[0]?.[1];
    expect(typeof request?.body).toBe('string');
    const body = typeof request?.body === 'string' ? request.body : '';
    expect(JSON.parse(body)).toMatchObject({ classification: 'L4' });
    expect(body).not.toMatch(/attachmentContent|fileBytes|sourceToken/u);
    expect(request?.redirect).toBe('error');
    expect(request?.headers).toMatchObject({
      accept: 'application/json',
      'cache-control': 'no-store',
      'content-type': 'application/json',
    });
    expect((request?.headers as Record<string, string>)['idempotency-key'])
      .toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it('回执摘要与来源声明不一致时失败关闭', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify(receipt({ checksum: 'd'.repeat(43) })),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));

    await expect(new HttpDataMigrationAttachmentGateway(config()).transfer(input()))
      .rejects.toThrow('DATA_MIGRATION_ATTACHMENT_RECEIPT_INVALID');
  });

  it('网关回执不得把服务端声明的 L4 降级为 L3', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify(receipt({ classification: 'L3' })),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));

    await expect(new HttpDataMigrationAttachmentGateway(config()).transfer(input()))
      .rejects.toThrow('DATA_MIGRATION_ATTACHMENT_RECEIPT_INVALID');
  });

  it.each([
    { tenantId: '*invalid' },
    { runId: 'bad' },
    { sourceSystem: 'contains space' },
    { sourceAttachmentId: '../file' },
    { expectedChecksum: 'bad' },
    { retentionDays: 2_554 },
    { retentionDays: 36_501 },
    { classification: 'L2' },
    { extra: 'forbidden' },
  ])('外呼前拒绝非法或扩张命令 %#', async (overrides) => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    await expect(new HttpDataMigrationAttachmentGateway(config()).transfer({
      ...input(),
      ...overrides,
    } as ReturnType<typeof input>)).rejects.toThrow(
      'DATA_MIGRATION_ATTACHMENT_COMMAND_INVALID',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      DATA_MIGRATION_ATTACHMENT_GATEWAY_ENDPOINT: undefined,
      DATA_MIGRATION_ATTACHMENT_GATEWAY_BEARER_TOKEN:
        'secret-token-at-least-thirty-two-characters',
    },
    {
      DATA_MIGRATION_ATTACHMENT_GATEWAY_ENDPOINT:
        'https://migration-files.example.test/v1/transfer',
      DATA_MIGRATION_ATTACHMENT_GATEWAY_BEARER_TOKEN: undefined,
    },
    {
      DATA_MIGRATION_ATTACHMENT_GATEWAY_ENDPOINT:
        'https://migration-files.example.test/v1/transfer',
      DATA_MIGRATION_ATTACHMENT_GATEWAY_BEARER_TOKEN: 'short',
    },
  ])('缺失或非法网关配置失败关闭 %#', async (overrides) => {
    await expect(new HttpDataMigrationAttachmentGateway(config(overrides)).transfer(input()))
      .rejects.toThrow('DATA_MIGRATION_ATTACHMENT_GATEWAY_UNAVAILABLE');
  });

  it.each([
    'not-a-url',
    'http://migration-files.example.test/v1/transfer',
    'https://user@migration-files.example.test/v1/transfer',
    'https://user:pass@migration-files.example.test/v1/transfer',
    'https://migration-files.example.test:8443/v1/transfer',
    'https://migration-files.example.test/v1/transfer?tenant=x',
    'https://migration-files.example.test/v1/transfer#fragment',
  ])('拒绝非标准或携带额外材料的网关端点 %s', async (endpoint) => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    await expect(new HttpDataMigrationAttachmentGateway(config({
      DATA_MIGRATION_ATTACHMENT_GATEWAY_ENDPOINT: endpoint,
    })).transfer(input())).rejects.toThrow(
      'DATA_MIGRATION_ATTACHMENT_GATEWAY_ENDPOINT_INVALID',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('网络异常归一为稳定不可用错误', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new Error('socket details')));
    await expect(new HttpDataMigrationAttachmentGateway(config()).transfer(input()))
      .rejects.toThrow('DATA_MIGRATION_ATTACHMENT_GATEWAY_UNAVAILABLE');
  });

  it.each([400, 401, 404, 409, 422, 429, 500])(
    '非 2xx %s 只按状态码分类',
    async (status) => {
      vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(
        'sensitive upstream body',
        { status },
      )));
      await expect(new HttpDataMigrationAttachmentGateway(config()).transfer(input()))
        .rejects.toThrow(`DATA_MIGRATION_ATTACHMENT_GATEWAY_HTTP_${status}`);
    },
  );

  it.each([
    ['非 JSON', { 'content-type': 'text/html' }],
    ['压缩正文', { 'content-type': 'application/json', 'content-encoding': 'gzip' }],
    ['非规范长度', { 'content-type': 'application/json', 'content-length': '+10' }],
    ['声明超限', { 'content-type': 'application/json', 'content-length': '999999' }],
  ])('拒绝%s', async (_label, headers) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify(receipt()),
      { status: 200, headers },
    )));
    await expect(new HttpDataMigrationAttachmentGateway(config()).transfer(input()))
      .rejects.toThrow('DATA_MIGRATION_ATTACHMENT_RECEIPT_INVALID');
  });

  it('接受 UTF-8 JSON 与 identity 编码的规范响应头', async () => {
    const body = JSON.stringify(receipt());
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-encoding': 'identity',
        'content-length': String(Buffer.byteLength(body)),
      },
    })));
    await expect(new HttpDataMigrationAttachmentGateway(config()).transfer(input()))
      .resolves.toMatchObject({ sourceAttachmentId: 'legacy-file-001' });
  });

  it('拒绝空响应流、实际超限正文、非法 UTF-8 与非法 JSON', async () => {
    const gateway = new HttpDataMigrationAttachmentGateway(config());
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('x'.repeat(16 * 1024 + 1), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(new Uint8Array([0xc3, 0x28]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('{bad json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })));

    await expect(gateway.transfer(input()))
      .rejects.toThrow('DATA_MIGRATION_ATTACHMENT_RECEIPT_INVALID');
    await expect(gateway.transfer(input()))
      .rejects.toThrow('DATA_MIGRATION_ATTACHMENT_RECEIPT_TOO_LARGE');
    await expect(gateway.transfer(input()))
      .rejects.toThrow('DATA_MIGRATION_ATTACHMENT_RECEIPT_INVALID');
    await expect(gateway.transfer(input()))
      .rejects.toThrow('DATA_MIGRATION_ATTACHMENT_RECEIPT_INVALID');
  });

  it('流读取异常时尝试取消，且取消异常不得覆盖原错误', async () => {
    const reader = {
      read: vi.fn().mockResolvedValue({ done: false, value: 'not-bytes' }),
      cancel: vi.fn().mockRejectedValue(new Error('cancel failed')),
      releaseLock: vi.fn(),
    };
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: { getReader: () => reader },
    } as unknown as Response));

    await expect(new HttpDataMigrationAttachmentGateway(config()).transfer(input()))
      .rejects.toThrow('DATA_MIGRATION_ATTACHMENT_RECEIPT_INVALID');
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });

  it.each([
    ['tenantId', 'tenant-002'],
    ['runId', '01J8ZQK7V0A2M4N6P8R0T2W4F9'],
    ['sourceSystem', 'other-system'],
    ['sourceAttachmentId', 'other-file'],
    ['checksum', 'd'.repeat(43)],
    ['classification', 'L3'],
  ])('回执字段 %s 未绑定请求时失败关闭', async (field, value) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify(receipt({ [field]: value })),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));
    await expect(new HttpDataMigrationAttachmentGateway(config()).transfer(input()))
      .rejects.toThrow('DATA_MIGRATION_ATTACHMENT_RECEIPT_INVALID');
  });

  it('回执保留期不得低于请求，且 Schema 必须严格无额外字段', async () => {
    const gateway = new HttpDataMigrationAttachmentGateway(config());
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(receipt({
        retentionDays: 2_555,
      })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(receipt({
        upstreamToken: 'forbidden',
      })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })));

    await expect(gateway.transfer({ ...input(), retentionDays: 3_000 }))
      .rejects.toThrow('DATA_MIGRATION_ATTACHMENT_RECEIPT_INVALID');
    await expect(gateway.transfer(input()))
      .rejects.toThrow('DATA_MIGRATION_ATTACHMENT_RECEIPT_INVALID');
  });
});
