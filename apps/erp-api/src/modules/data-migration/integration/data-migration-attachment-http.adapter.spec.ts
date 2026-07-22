import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../../config/environment.js';
import { HttpDataMigrationAttachmentGateway } from './data-migration-attachment-http.adapter.js';

afterEach(() => vi.unstubAllGlobals());

function config(): ConfigService<AppEnvironment, true> {
  const values: Partial<AppEnvironment> = {
    DATA_MIGRATION_ATTACHMENT_GATEWAY_ENDPOINT: 'https://migration-files.example.test/v1/transfer',
    DATA_MIGRATION_ATTACHMENT_GATEWAY_BEARER_TOKEN: 'secret-token-at-least-thirty-two-characters',
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

describe('数据迁移附件隔离网关', () => {
  it('只发送控制标识并严格校验扫描与不可变归档回执', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      targetEvidenceId: 'worm/migration/file-001',
      malwareScanEvidenceId: 'scan-001', checksum: 'c'.repeat(43),
      immutable: true, malwareClean: true, retentionDays: 2_555,
      classification: 'L4',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
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
  });

  it('回执摘要与来源声明不一致时失败关闭', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      targetEvidenceId: 'worm/migration/file-001',
      malwareScanEvidenceId: 'scan-001', checksum: 'd'.repeat(43),
      immutable: true, malwareClean: true, retentionDays: 2_555,
      classification: 'L4',
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    await expect(new HttpDataMigrationAttachmentGateway(config()).transfer(input()))
      .rejects.toThrow('DATA_MIGRATION_ATTACHMENT_RECEIPT_INVALID');
  });

  it('网关回执不得把服务端声明的 L4 降级为 L3', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      targetEvidenceId: 'worm/migration/file-001',
      malwareScanEvidenceId: 'scan-001', checksum: 'c'.repeat(43),
      immutable: true, malwareClean: true, retentionDays: 2_555, classification: 'L3',
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    await expect(new HttpDataMigrationAttachmentGateway(config()).transfer(input()))
      .rejects.toThrow('DATA_MIGRATION_ATTACHMENT_RECEIPT_INVALID');
  });
});
