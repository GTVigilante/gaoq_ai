import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../../config/environment.js';
import { HttpPayrollAnnualAssessmentGateway } from './payroll-annual-assessment-http.adapter.js';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({
  format: 'der',
  type: 'spki',
}).toString('base64');
const tenantId = 'tenant-001';
const employeeId = 'employee-001';
const reconciliationId = '01J8ZQK7V0A2M4N6P8R0T2W4P1';
const evidenceHash = 'e'.repeat(43);

function config(overrides: Partial<AppEnvironment> = {}) {
  return new ConfigService<AppEnvironment, true>({
    PAYROLL_TAX_GATEWAY_ENDPOINT: 'https://tax-gateway.example.net/v1/submissions',
    PAYROLL_TAX_GATEWAY_BEARER_TOKEN:
      'tax-gateway-token-that-is-at-least-32-characters',
    PAYROLL_TAX_GATEWAY_SIGNING_KEY_ID: 'tax-key-001',
    PAYROLL_TAX_GATEWAY_SIGNING_PUBLIC_KEY_BASE64: publicKey,
    PAYROLL_TAX_OFFICIAL_PORTAL_ORIGIN: 'https://official.tax.example.cn',
    ...overrides,
  } as AppEnvironment);
}

function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('base64url');
}

function signedResponse(
  receipt: Readonly<Record<string, unknown>>,
  privateKey: KeyObject = keys.privateKey,
  headers: Record<string, string> = {},
): Response {
  const body = JSON.stringify(receipt);
  const signature = sign(
    null,
    Buffer.from(
      `gaoq-payroll-annual-receipt-v1\ntax-key-001\n${
        createHash('sha256').update(body, 'utf8').digest('base64url')
      }`,
      'utf8',
    ),
    privateKey,
  ).toString('base64url');
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'x-gaoq-signing-key-id': 'tax-key-001',
      'x-gaoq-signature': signature,
      ...headers,
    },
  });
}

function assessmentReceipt(overrides: Record<string, unknown> = {}) {
  const payload = { tenantId, employeeId, taxYear: '2026' };
  return {
    ...payload,
    controlDigest: digest(payload),
    assessmentId: 'assessment-2026',
    assessmentEvidenceId: 'assessment-evidence-2026',
    assessedTaxMinor: 21_000,
    sourceDigest: 's'.repeat(43),
    issuedAt: new Date().toISOString(),
    ...overrides,
  };
}

function settlementReceipt(overrides: Record<string, unknown> = {}) {
  const payload = {
    tenantId,
    employeeId,
    annualReconciliationId: reconciliationId,
    taxYear: '2026',
    evidenceHash,
  };
  return {
    ...payload,
    controlDigest: digest(payload),
    settlementUrl: 'https://official.tax.example.cn/settlement?token=opaque',
    expiresAt: new Date(Date.now() + 2 * 60_000).toISOString(),
    issuedAt: new Date().toISOString(),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HttpPayrollAnnualAssessmentGateway', () => {
  it('仅发送最小控制字段并返回已验签官方年度评估', async () => {
    const fetchMock = vi.fn().mockResolvedValue(signedResponse(assessmentReceipt()));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new HttpPayrollAnnualAssessmentGateway(config());

    await expect(adapter.resolve({
      tenantId,
      employeeId,
      taxYear: '2026',
      idempotencyKey: 'annual-assessment-001',
    })).resolves.toEqual({
      assessmentId: 'assessment-2026',
      assessmentEvidenceId: 'assessment-evidence-2026',
      assessedTaxMinor: 21_000,
      sourceDigest: 's'.repeat(43),
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://tax-gateway.example.net/v1/annual-assessments/resolve');
    const requestHeaders = init.headers as Record<string, string>;
    expect(requestHeaders.authorization).toMatch(/^Bearer /u);
    expect(requestHeaders).toMatchObject({
      'idempotency-key': 'annual-assessment-001',
      'accept-encoding': 'identity',
    });
    if (typeof init.body !== 'string') throw new Error('测试请求体必须为字符串');
    const body = JSON.parse(init.body) as unknown;
    expect(body).toEqual({
      tenantId,
      employeeId,
      taxYear: '2026',
      controlDigest: digest({ tenantId, employeeId, taxYear: '2026' }),
    });
    expect(JSON.stringify(body)).not.toMatch(/assessedTax|evidenceId|sourceDigest/u);
  });

  it('为员工本人返回同源且五分钟内失效的官方办理链接', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      signedResponse(settlementReceipt()),
    ));
    const adapter = new HttpPayrollAnnualAssessmentGateway(config());

    await expect(adapter.createSettlementLink({
      tenantId,
      employeeId,
      annualReconciliationId: reconciliationId,
      taxYear: '2026',
      evidenceHash,
      idempotencyKey: 'annual-settlement-001',
    })).resolves.toMatchObject({
      settlementUrl:
        'https://official.tax.example.cn/settlement?token=opaque',
    });
  });

  it.each([
    ['错误请求摘要', assessmentReceipt({ controlDigest: 'x'.repeat(43) })],
    ['跨租户', assessmentReceipt({ tenantId: 'tenant-other' })],
    ['过期回执', assessmentReceipt({
      issuedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
    })],
    ['额外字段', assessmentReceipt({ extra: true })],
    ['证据标识复用', assessmentReceipt({
      assessmentId: 'same',
      assessmentEvidenceId: 'same',
    })],
  ])('拒绝未严格绑定的官方评估回执：%s', async (_name, receipt) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(signedResponse(receipt)));
    await expect(new HttpPayrollAnnualAssessmentGateway(config()).resolve({
      tenantId,
      employeeId,
      taxYear: '2026',
      idempotencyKey: 'annual-assessment-invalid',
    })).rejects.toThrow(/PAYROLL_ANNUAL_ASSESSMENT_RECEIPT_INVALID/u);
  });

  it('拒绝错误签名、错误 key id 与压缩响应', async () => {
    const other = generateKeyPairSync('ed25519');
    for (const response of [
      signedResponse(assessmentReceipt(), other.privateKey),
      signedResponse(assessmentReceipt(), keys.privateKey, {
        'x-gaoq-signing-key-id': 'tax-key-other',
      }),
      signedResponse(assessmentReceipt(), keys.privateKey, {
        'content-encoding': 'gzip',
      }),
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      await expect(new HttpPayrollAnnualAssessmentGateway(config()).resolve({
        tenantId,
        employeeId,
        taxYear: '2026',
        idempotencyKey: 'annual-assessment-signature',
      })).rejects.toThrow(/PAYROLL_ANNUAL_GATEWAY_/u);
    }
  });

  it.each([
    ['跨域链接', {
      settlementUrl: 'https://evil.example.net/settlement?token=opaque',
    }, 'PAYROLL_ANNUAL_SETTLEMENT_URL_INVALID'],
    ['带 fragment', {
      settlementUrl: 'https://official.tax.example.cn/settlement#token',
    }, 'PAYROLL_ANNUAL_SETTLEMENT_URL_INVALID'],
    ['过短有效期', {
      expiresAt: new Date(Date.now() + 10_000).toISOString(),
    }, 'PAYROLL_ANNUAL_SETTLEMENT_RECEIPT_INVALID'],
    ['过长有效期', {
      expiresAt: new Date(Date.now() + 6 * 60_000).toISOString(),
    }, 'PAYROLL_ANNUAL_SETTLEMENT_RECEIPT_INVALID'],
  ])('拒绝不安全的员工办理回执：%s', async (_name, override, code) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      signedResponse(settlementReceipt(override)),
    ));
    await expect(new HttpPayrollAnnualAssessmentGateway(config())
      .createSettlementLink({
        tenantId,
        employeeId,
        annualReconciliationId: reconciliationId,
        taxYear: '2026',
        evidenceHash,
        idempotencyKey: 'annual-settlement-invalid',
      })).rejects.toThrow(code);
  });

  it.each([
    [{ PAYROLL_TAX_GATEWAY_ENDPOINT: 'http://tax.example.net/v1/submissions' },
      'PAYROLL_ANNUAL_GATEWAY_ENDPOINT_INVALID'],
    [{ PAYROLL_TAX_GATEWAY_BEARER_TOKEN: 'short' },
      'PAYROLL_ANNUAL_GATEWAY_CREDENTIAL_INVALID'],
    [{ PAYROLL_TAX_GATEWAY_SIGNING_KEY_ID: 'bad' },
      'PAYROLL_ANNUAL_SIGNING_KEY_INVALID'],
    [{ PAYROLL_TAX_GATEWAY_SIGNING_PUBLIC_KEY_BASE64: 'AAAA' },
      'PAYROLL_ANNUAL_SIGNING_KEY_INVALID'],
  ])('配置非法时在网络调用前失败关闭 %#', async (override, code) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(new HttpPayrollAnnualAssessmentGateway(
      config(override as Partial<AppEnvironment>),
    ).resolve({
      tenantId,
      employeeId,
      taxYear: '2026',
      idempotencyKey: 'annual-assessment-config',
    })).rejects.toThrow(code);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('拒绝非法输入且不调用网关', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(new HttpPayrollAnnualAssessmentGateway(config()).resolve({
      tenantId,
      employeeId: '',
      taxYear: '2026',
      idempotencyKey: 'annual-assessment-input',
    })).rejects.toThrow('PAYROLL_ANNUAL_ASSESSMENT_INPUT_INVALID');
    await expect(new HttpPayrollAnnualAssessmentGateway(config())
      .createSettlementLink({
        tenantId,
        employeeId,
        annualReconciliationId: 'bad',
        taxYear: '2026',
        evidenceHash,
        idempotencyKey: 'annual-settlement-input',
      })).rejects.toThrow('PAYROLL_ANNUAL_SETTLEMENT_INPUT_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('缺少配置、网络失败与 HTTP 失败均返回稳定错误', async () => {
    await expect(new HttpPayrollAnnualAssessmentGateway(config({
      PAYROLL_TAX_GATEWAY_ENDPOINT: undefined,
    })).resolve({
      tenantId,
      employeeId,
      taxYear: '2026',
      idempotencyKey: 'annual-assessment-missing',
    })).rejects.toThrow('PAYROLL_ANNUAL_GATEWAY_UNAVAILABLE');

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('secret upstream')));
    await expect(new HttpPayrollAnnualAssessmentGateway(config()).resolve({
      tenantId,
      employeeId,
      taxYear: '2026',
      idempotencyKey: 'annual-assessment-network',
    })).rejects.toThrow('PAYROLL_ANNUAL_GATEWAY_UNAVAILABLE');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', {
      status: 503,
    })));
    await expect(new HttpPayrollAnnualAssessmentGateway(config()).resolve({
      tenantId,
      employeeId,
      taxYear: '2026',
      idempotencyKey: 'annual-assessment-http',
    })).rejects.toThrow('PAYROLL_ANNUAL_GATEWAY_HTTP_503');
  });

  it('拒绝非 JSON 回执、非 Ed25519 公钥与非法官方 origin', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    })));
    await expect(new HttpPayrollAnnualAssessmentGateway(config()).resolve({
      tenantId,
      employeeId,
      taxYear: '2026',
      idempotencyKey: 'annual-assessment-content-type',
    })).rejects.toThrow('PAYROLL_ANNUAL_GATEWAY_RECEIPT_INVALID');

    const ecPublicKey = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    await expect(new HttpPayrollAnnualAssessmentGateway(config({
      PAYROLL_TAX_GATEWAY_SIGNING_PUBLIC_KEY_BASE64: ecPublicKey,
    })).resolve({
      tenantId,
      employeeId,
      taxYear: '2026',
      idempotencyKey: 'annual-assessment-key-type',
    })).rejects.toThrow('PAYROLL_ANNUAL_SIGNING_KEY_INVALID');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      signedResponse(settlementReceipt()),
    ));
    await expect(new HttpPayrollAnnualAssessmentGateway(config({
      PAYROLL_TAX_OFFICIAL_PORTAL_ORIGIN: 'not-a-url',
    })).createSettlementLink({
      tenantId,
      employeeId,
      annualReconciliationId: reconciliationId,
      taxYear: '2026',
      evidenceHash,
      idempotencyKey: 'annual-settlement-origin',
    })).rejects.toThrow('PAYROLL_ANNUAL_SETTLEMENT_URL_INVALID');
  });
});
