import { createHash } from 'node:crypto';

import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import {
  HttpESignImmutableArchive,
  HttpESignMalwareScanner,
} from './esign-evidence-http.adapters.js';

const FLOW_ID = '01J8ZQK7V0A2M4N6P8R0T2W4F1';
const PDF = Buffer.from('%PDF-1.7\n受控测试合同');
const SHA256 = createHash('sha256').update(PDF).digest('base64url');
const OBJECT_KEY = `esign/${FLOW_ID}/${SHA256}.pdf`;

function archiveInput(
  overrides?: Partial<Parameters<HttpESignImmutableArchive['put']>[0]>,
): Parameters<HttpESignImmutableArchive['put']>[0] {
  return {
    tenantId: 'tenant-001',
    objectKey: OBJECT_KEY,
    contentType: 'application/pdf' as const,
    classification: 'L4' as const,
    retentionPolicy: 'employment_contract' as const,
    sha256: SHA256,
    bytes: PDF,
    ...overrides,
  };
}

function config(overrides?: Readonly<Record<string, string | number>>) {
  const values: Readonly<Record<string, string | number>> = {
    ESIGN_MALWARE_SCAN_ENDPOINT: 'https://scanner.example.internal/v1/scan',
    ESIGN_MALWARE_SCAN_BEARER_TOKEN: 'scanner-token-that-is-at-least-32-characters',
    ESIGN_WORM_ARCHIVE_ENDPOINT: 'https://worm.example.internal/v1/objects',
    ESIGN_WORM_ARCHIVE_BEARER_TOKEN: 'archive-token-that-is-at-least-32-characters',
    ESIGN_WORM_RETENTION_DAYS: 3_650,
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService<AppEnvironment, true>;
}

afterEach(() => vi.unstubAllGlobals());

describe('eSign 证据 HTTPS Adapters', () => {
  it('扫描正文只通过 HTTPS 请求体发送，回执必须绑定摘要且幂等键不暴露租户', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      clean: true, evidenceId: 'scan-evidence-001', sha256: SHA256,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const scanner = new HttpESignMalwareScanner(config());
    await expect(scanner.scan({
      tenantId: 'tenant-001', flowId: FLOW_ID, sha256: SHA256, bytes: PDF,
    })).resolves.toEqual({ clean: true, evidenceId: 'scan-evidence-001' });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = call[1].headers as Readonly<Record<string, string>>;
    expect(call[0]).toBe('https://scanner.example.internal/v1/scan');
    expect(call[1]).toMatchObject({ method: 'POST', redirect: 'error', body: PDF });
    expect(headers['x-content-sha256']).toBe(SHA256);
    expect(headers['idempotency-key']).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(headers['idempotency-key']).not.toContain('tenant-001');
    expect(JSON.stringify(headers)).not.toContain(PDF.toString('utf8'));
  });

  it('扫描前复算 PDF 摘要，内容不符时不调用外部服务', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const scanner = new HttpESignMalwareScanner(config());
    await expect(scanner.scan({
      tenantId: 'tenant-001', flowId: FLOW_ID, sha256: 'A'.repeat(43), bytes: PDF,
    })).rejects.toThrow('ESIGN_EVIDENCE_HASH_MISMATCH');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('证据基础设施未配置时保持失败关闭，不产生伪扫描或伪归档回执', async () => {
    const empty = { get: () => undefined } as unknown as ConfigService<AppEnvironment, true>;
    await expect(new HttpESignMalwareScanner(empty).scan({
      tenantId: 'tenant-001', flowId: FLOW_ID, sha256: SHA256, bytes: PDF,
    })).rejects.toThrow('ESIGN_MALWARE_SCANNER_UNAVAILABLE');
    await expect(new HttpESignImmutableArchive(empty).put({
      tenantId: 'tenant-001', objectKey: OBJECT_KEY, contentType: 'application/pdf',
      classification: 'L4', retentionPolicy: 'employment_contract', sha256: SHA256, bytes: PDF,
    })).rejects.toThrow('ESIGN_IMMUTABLE_ARCHIVE_UNAVAILABLE');
  });

  it('WORM 归档强制对象键、内容摘要、不可变回执和十年保留期', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      objectRef: 'worm/esign/locked-object-001', receiptId: 'archive-receipt-001',
      immutable: true, sha256: SHA256, objectKey: OBJECT_KEY, retentionDays: 3_650,
    }), { status: 201, headers: { 'content-type': 'application/json; charset=utf-8' } }));
    vi.stubGlobal('fetch', fetchMock);
    const archive = new HttpESignImmutableArchive(config());
    await expect(archive.put({
      tenantId: 'tenant-001', objectKey: OBJECT_KEY, contentType: 'application/pdf',
      classification: 'L4', retentionPolicy: 'employment_contract',
      sha256: SHA256, bytes: PDF,
    })).resolves.toEqual({
      objectRef: 'worm/esign/locked-object-001',
      receiptId: 'archive-receipt-001', immutable: true,
    });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = call[1].headers as Readonly<Record<string, string>>;
    expect(call[0]).toBe('https://worm.example.internal/v1/objects');
    expect(headers).toMatchObject({
      'x-object-key': OBJECT_KEY, 'x-data-classification': 'L4',
      'x-retention-policy': 'employment_contract', 'x-retention-days': '3650',
    });
  });

  it('WORM 回执可变、摘要错位或保留期不足时失败关闭', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      objectRef: 'worm/esign/object-001', receiptId: 'receipt-001', immutable: false,
      sha256: SHA256, objectKey: OBJECT_KEY, retentionDays: 365,
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const archive = new HttpESignImmutableArchive(config());
    await expect(archive.put({
      tenantId: 'tenant-001', objectKey: OBJECT_KEY, contentType: 'application/pdf',
      classification: 'L4', retentionPolicy: 'employment_contract', sha256: SHA256, bytes: PDF,
    })).rejects.toThrow('ESIGN_ARCHIVE_RECEIPT_INVALID');
  });

  it('非 PDF、超限文件和错误对象键在外部调用前失败关闭', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const scanner = new HttpESignMalwareScanner(config());
    await expect(scanner.scan({
      tenantId: 'tenant-001',
      flowId: FLOW_ID,
      sha256: createHash('sha256').update('hello').digest('base64url'),
      bytes: Buffer.from('hello'),
    })).rejects.toThrow('ESIGN_EVIDENCE_PDF_INVALID');
    const archive = new HttpESignImmutableArchive(config());
    await expect(archive.put(archiveInput({
      objectKey: `esign/${FLOW_ID}/wrong.pdf`,
    }))).rejects.toThrow('ESIGN_ARCHIVE_OBJECT_KEY_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('扫描回执摘要错位或结构非法时失败关闭', async () => {
    const scanner = new HttpESignMalwareScanner(config());
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      clean: true,
      evidenceId: 'scan-evidence-001',
      sha256: 'A'.repeat(43),
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    await expect(scanner.scan({
      tenantId: 'tenant-001', flowId: FLOW_ID, sha256: SHA256, bytes: PDF,
    })).rejects.toThrow('ESIGN_MALWARE_SCAN_RECEIPT_INVALID');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    await expect(scanner.scan({
      tenantId: 'tenant-001', flowId: FLOW_ID, sha256: SHA256, bytes: PDF,
    })).rejects.toThrow('ESIGN_MALWARE_SCAN_RECEIPT_INVALID');
  });

  it.each([
    [vi.fn().mockRejectedValue(new Error('network')), 'ESIGN_MALWARE_SCANNER_UNAVAILABLE'],
    [vi.fn().mockResolvedValue(new Response('{}', {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })), 'ESIGN_MALWARE_SCANNER_HTTP_503'],
    [vi.fn().mockResolvedValue(new Response('{}', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    })), 'ESIGN_MALWARE_SCANNER_RECEIPT_INVALID'],
    [vi.fn().mockResolvedValue(new Response('{', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })), 'ESIGN_MALWARE_SCAN_RECEIPT_INVALID'],
    [vi.fn().mockResolvedValue(new Response('x'.repeat(16 * 1024 + 1), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })), 'ESIGN_MALWARE_SCAN_RECEIPT_TOO_LARGE'],
  ])('扫描网关故障使用稳定错误：%s', async (fetchMock, code) => {
    vi.stubGlobal('fetch', fetchMock);
    await expect(new HttpESignMalwareScanner(config()).scan({
      tenantId: 'tenant-001', flowId: FLOW_ID, sha256: SHA256, bytes: PDF,
    })).rejects.toThrow(code);
  });

  it.each([
    ['http://scanner.example.internal/v1/scan'],
    ['https://user:pass@scanner.example.internal/v1/scan'],
    ['https://scanner.example.internal:8443/v1/scan'],
    ['https://scanner.example.internal/v1/scan?token=secret'],
    ['https://scanner.example.internal/v1/scan#fragment'],
  ])('拒绝不安全的证据网关端点：%s', async (endpoint) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(new HttpESignMalwareScanner(config({
      ESIGN_MALWARE_SCAN_ENDPOINT: endpoint,
    })).scan({
      tenantId: 'tenant-001', flowId: FLOW_ID, sha256: SHA256, bytes: PDF,
    })).rejects.toThrow('ESIGN_EVIDENCE_ENDPOINT_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('WORM 回执必须逐项绑定摘要、对象键、不可变性和保留期', async () => {
    const archive = new HttpESignImmutableArchive(config());
    for (const receipt of [
      {
        objectRef: 'worm/esign/object-001', receiptId: 'receipt-001', immutable: true,
        sha256: 'A'.repeat(43), objectKey: OBJECT_KEY, retentionDays: 3_650,
      },
      {
        objectRef: 'worm/esign/object-001', receiptId: 'receipt-001', immutable: true,
        sha256: SHA256, objectKey: `esign/${FLOW_ID}/${'A'.repeat(43)}.pdf`,
        retentionDays: 3_650,
      },
      {
        objectRef: 'worm/esign/object-001', receiptId: 'receipt-001', immutable: true,
        sha256: SHA256, objectKey: OBJECT_KEY, retentionDays: 3_649,
      },
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(receipt), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })));
      await expect(archive.put(archiveInput()))
        .rejects.toThrow('ESIGN_ARCHIVE_RECEIPT_INVALID');
    }
  });
});
