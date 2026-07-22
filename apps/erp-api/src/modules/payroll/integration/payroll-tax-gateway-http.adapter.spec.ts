import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../../config/environment.js';
import { HttpPayrollTaxGateway } from './payroll-tax-gateway-http.adapter.js';

const input = Object.freeze({
  tenantId: 'tenant-001', filingId: '01J8ZQK7V0A2M4N6P8R0T2W4F1', period: '2026-07',
  objectRef: 'worm/payroll-tax/locked-object-001', contentHash: 'a'.repeat(43),
  employeeCount: 2, totalTaxableEarningsMinor: 1_800_000,
  totalWithholdingTaxMinor: 21_000, productionAuthorization: null,
});
const productionAuthorization = Object.freeze({
  authorizationId: 'authorization-001', evidenceId: 'authorization-evidence-001',
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  releaseCommitSha: 'c'.repeat(40), deploymentManifestHash: `sha256:${'d'.repeat(64)}`,
});

function config(overrides?: Readonly<Record<string, string>>) {
  const values: Readonly<Record<string, string>> = {
    PAYROLL_TAX_GATEWAY_ENDPOINT: 'https://tax-gateway.example.internal/v1/submissions',
    PAYROLL_TAX_GATEWAY_BEARER_TOKEN: 'tax-gateway-token-at-least-32-characters',
    PAYROLL_TAX_GATEWAY_MODE: 'sandbox',
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService<AppEnvironment, true>;
}

function receipt(changes?: Readonly<Record<string, unknown>>) {
  return {
    submissionId: 'tax-submission-001', evidenceId: 'tax-evidence-001', accepted: true,
    ...input, productionAuthorization: undefined, submissionMode: 'sandbox', ...changes,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('Payroll Tax 税务网关 HTTPS Adapter', () => {
  it('只提交 WORM 引用与控制量并严格绑定受理回执', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(receipt()), {
      status: 202, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new HttpPayrollTaxGateway(config()).submit(input)).resolves.toEqual({
      submissionId: 'tax-submission-001', evidenceId: 'tax-evidence-001', accepted: true,
      productionAuthorizationEvidenceId: null,
    });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    if (typeof call[1].body !== 'string') throw new Error('测试请求体必须是 JSON 字符串');
    expect(call[0]).toBe('https://tax-gateway.example.internal/v1/submissions');
    expect(JSON.parse(call[1].body)).toEqual({
      tenantId: input.tenantId, filingId: input.filingId, period: input.period,
      objectRef: input.objectRef, contentHash: input.contentHash,
      employeeCount: input.employeeCount,
      totalTaxableEarningsMinor: input.totalTaxableEarningsMinor,
      totalWithholdingTaxMinor: input.totalWithholdingTaxMinor,
      submissionMode: 'sandbox',
    });
    expect(call[1].body).not.toMatch(/employeeId|identityEvidence|certificate|taxpayerId/u);
    expect((call[1].headers as Record<string, string>)['idempotency-key'])
      .toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it('拒绝错租户、错清单、错摘要、未受理与超大回执', async () => {
    for (const invalid of [
      receipt({ tenantId: 'tenant-002' }), receipt({ filingId: 'another-filing' }),
      receipt({ contentHash: 'b'.repeat(43) }), receipt({ accepted: false }),
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(invalid), {
        status: 200, headers: { 'content-type': 'application/json' },
      })));
      await expect(new HttpPayrollTaxGateway(config()).submit(input))
        .rejects.toThrow('PAYROLL_TAX_GATEWAY_RECEIPT_INVALID');
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x'.repeat(20_000), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));
    await expect(new HttpPayrollTaxGateway(config()).submit(input))
      .rejects.toThrow('PAYROLL_TAX_GATEWAY_RECEIPT_TOO_LARGE');
  });

  it('未配置、非法端点或上游失败时失败关闭', async () => {
    const empty = { get: () => undefined } as unknown as ConfigService<AppEnvironment, true>;
    await expect(new HttpPayrollTaxGateway(empty).submit(input))
      .rejects.toThrow('PAYROLL_TAX_GATEWAY_UNAVAILABLE');
    await expect(new HttpPayrollTaxGateway(config({
      PAYROLL_TAX_GATEWAY_ENDPOINT: 'http://tax-gateway.example/v1/submissions',
    })).submit(input)).rejects.toThrow('PAYROLL_TAX_ENDPOINT_INVALID');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
    await expect(new HttpPayrollTaxGateway(config()).submit(input))
      .rejects.toThrow('PAYROLL_TAX_GATEWAY_HTTP_503');
  });

  it('production 必须携带短时授权且要求税务网关精确回显', async () => {
    await expect(new HttpPayrollTaxGateway(config({
      PAYROLL_TAX_GATEWAY_MODE: 'production',
    })).submit(input)).rejects.toThrow('PAYROLL_TAX_PRODUCTION_AUTHORIZATION_INVALID');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(receipt({
      submissionMode: 'production', productionAuthorizationId: 'authorization-001',
      productionAuthorizationEvidenceId: 'authorization-evidence-001',
      releaseCommitSha: productionAuthorization.releaseCommitSha,
      deploymentManifestHash: productionAuthorization.deploymentManifestHash,
    })), { status: 202, headers: { 'content-type': 'application/json' } })));
    await expect(new HttpPayrollTaxGateway(config({
      PAYROLL_TAX_GATEWAY_MODE: 'production',
    })).submit({ ...input, productionAuthorization })).resolves.toMatchObject({
      productionAuthorizationEvidenceId: 'authorization-evidence-001',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(receipt({
      submissionMode: 'production',
    })), { status: 202, headers: { 'content-type': 'application/json' } })));
    await expect(new HttpPayrollTaxGateway(config()).submit(input))
      .rejects.toThrow('PAYROLL_TAX_GATEWAY_RECEIPT_INVALID');
  });
});
