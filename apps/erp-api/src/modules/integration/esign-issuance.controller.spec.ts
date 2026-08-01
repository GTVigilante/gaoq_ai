import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { ESignIssuanceController } from './esign-issuance.controller.js';
import type { ESignIssuanceService } from './esign-issuance.service.js';

const REQUEST_ID = '01J8ZQK7V0A2M4N6P8R0T2W4C1';
const OFFER_ID = '01J8ZQK7V0A2M4N6P8R0T2W4C2';

function fixture() {
  const request = vi.fn().mockResolvedValue({
    request: { id: REQUEST_ID, offerId: OFFER_ID, status: 'pending' },
  });
  const listTerminal = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
  const resolve = vi.fn().mockResolvedValue({
    request: { id: REQUEST_ID, offerId: OFFER_ID, status: 'pending' },
  });
  const record = vi.fn().mockResolvedValue(undefined);
  const controller = new ESignIssuanceController(
    { request, listTerminal, resolve } as unknown as ESignIssuanceService,
    { record } as unknown as AuditService,
  );
  return { controller, request, listTerminal, resolve, record };
}

const REQUEST_BODY = {
  offerId: OFFER_ID,
  providerFileId: 'provider-file-001',
  expiresAt: '2099-01-01T00:00:00.000Z',
  signaturePosition: { page: 1, x: 100, y: 200 },
};

describe('ESignIssuanceController', () => {
  it('以 202 语义提交无候选人原文的发起请求并记录 R2 审计', async () => {
    const store = fixture();
    await expect(store.controller.request('esign-request-key-001', REQUEST_BODY))
      .resolves.toMatchObject({ request: { id: REQUEST_ID, status: 'pending' } });
    expect(store.request).toHaveBeenCalledWith({
      ...REQUEST_BODY,
      idempotencyKey: 'esign-request-key-001',
    });
    expect(store.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'integration.esign.issuance.request',
      riskLevel: 'R2',
      outcome: 'success',
      metadata: { offerId: OFFER_ID },
    }));
  });

  it.each([
    ['额外字段', { ...REQUEST_BODY, signerName: '张三' }],
    ['非法 Offer', { ...REQUEST_BODY, offerId: 'bad' }],
    ['非法文件', { ...REQUEST_BODY, providerFileId: '../file' }],
    ['非法坐标', { ...REQUEST_BODY, signaturePosition: { page: 1.5, x: 0, y: 0 } }],
  ])('%s在服务调用前失败关闭', async (_label, body) => {
    const store = fixture();
    await expect(store.controller.request('esign-request-key-001', body))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(store.request).not.toHaveBeenCalled();
  });

  it('查询只转发脱敏终态分页条件', async () => {
    const store = fixture();
    await expect(store.controller.list('manual_review', REQUEST_ID, '100'))
      .resolves.toEqual({ items: [], nextCursor: null });
    expect(store.listTerminal).toHaveBeenCalledWith({
      status: 'manual_review',
      beforeId: REQUEST_ID,
      limit: 100,
    });
  });

  it.each([
    ['状态', () => fixture().controller.list('pending', undefined, undefined)],
    ['游标', () => fixture().controller.list('dead', 'bad', undefined)],
    ['数量', () => fixture().controller.list('dead', undefined, '0')],
  ])('%s非法时失败关闭', (_label, invoke) => {
    expect(invoke).toThrow(BadRequestException);
  });

  it('以供应商确认未提交的批准例外重新入队', async () => {
    const store = fixture();
    await store.controller.resolve(
      REQUEST_ID,
      'esign-resolution-key-001',
      {
        decision: 'retry',
        reason: 'approved_exception',
        providerConfirmedNotCommitted: true,
        providerConfirmedMatchesRequest: false,
      },
    );
    expect(store.resolve).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      decision: 'retry',
      reason: 'approved_exception',
      providerConfirmedNotCommitted: true,
      providerConfirmedMatchesRequest: false,
      idempotencyKey: 'esign-resolution-key-001',
    });
  });

  it('允许经供应商核验后绑定外部流程但不直接伪造成功', async () => {
    const store = fixture();
    await store.controller.resolve(
      REQUEST_ID,
      'esign-resolution-key-002',
      {
        decision: 'attach_external_flow',
        reason: 'provider_recovered',
        providerConfirmedNotCommitted: false,
        providerConfirmedMatchesRequest: true,
        externalFlowId: 'external-flow-001',
      },
    );
    expect(store.resolve).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'attach_external_flow',
      externalFlowId: 'external-flow-001',
    }));
  });

  it.each([
    ['未知字段', {
      decision: 'retry', reason: 'approved_exception',
      providerConfirmedNotCommitted: true,
      providerConfirmedMatchesRequest: false,
      tenantId: 'tenant-evil',
    }],
    ['非法原因', {
      decision: 'retry', reason: 'unknown',
      providerConfirmedNotCommitted: true,
      providerConfirmedMatchesRequest: false,
    }],
    ['非法外部标识', {
      decision: 'attach_external_flow', reason: 'provider_recovered',
      providerConfirmedNotCommitted: false,
      providerConfirmedMatchesRequest: true,
      externalFlowId: '../flow',
    }],
  ])('%s处置请求失败关闭', async (_label, body) => {
    const store = fixture();
    await expect(store.controller.resolve(
      REQUEST_ID,
      'esign-resolution-key-003',
      body,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(store.resolve).not.toHaveBeenCalled();
  });

  it('处置业务失败保留原始错误并记录失败审计', async () => {
    const store = fixture();
    store.resolve.mockRejectedValueOnce(new Error('供应商状态不可用'));

    await expect(store.controller.resolve(
      REQUEST_ID,
      'esign-resolution-key-004',
      {
        decision: 'retry',
        reason: 'provider_recovered',
        providerConfirmedNotCommitted: true,
        providerConfirmedMatchesRequest: false,
      },
    )).rejects.toThrow('供应商状态不可用');
    expect(store.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'integration.esign.issuance.resolve',
      outcome: 'failure',
    }));
  });

  it('缺少幂等键时在业务调用前失败关闭', async () => {
    const store = fixture();

    await expect(store.controller.request(undefined, REQUEST_BODY))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(store.request).not.toHaveBeenCalled();
  });

  it('业务失败审计故障不覆盖原始错误，成功审计故障不反写业务失败', async () => {
    const failed = fixture();
    failed.request.mockRejectedValueOnce(new Error('原始业务错误'));
    failed.record.mockRejectedValueOnce(new Error('审计不可用'));
    await expect(failed.controller.request('esign-request-key-002', REQUEST_BODY))
      .rejects.toThrow('原始业务错误');

    const succeeded = fixture();
    succeeded.record.mockRejectedValueOnce(new Error('审计不可用'));
    await expect(succeeded.controller.request('esign-request-key-003', REQUEST_BODY))
      .resolves.toMatchObject({ request: { id: REQUEST_ID } });
  });
});
