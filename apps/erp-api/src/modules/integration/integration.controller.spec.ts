import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { IntegrationController } from './integration.controller.js';
import type { OrgDeliveryOperationsService } from './org-delivery-operations.service.js';

const EVENT_ID = '01K00000000000000000000000';

describe('IntegrationController', () => {
  it('人工重试校验枚举参数、调用应用服务并记录 R2 审计', async () => {
    const retry = vi.fn().mockResolvedValue({ delivery: { status: 'pending' } });
    const record = vi.fn().mockResolvedValue(undefined);
    const controller = new IntegrationController(
      { retry } as unknown as OrgDeliveryOperationsService,
      { record } as unknown as AuditService,
    );

    await controller.retry(
      EVENT_ID,
      'feishu',
      'retry-key-0001',
      { reason: 'provider_recovered' },
    );

    expect(retry).toHaveBeenCalledWith(
      EVENT_ID, 'feishu', 'provider_recovered', 'retry-key-0001',
    );
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'integration.org_delivery.retry', riskLevel: 'R2', outcome: 'success',
    }));
  });

  it('拒绝任意 reason、channel 与分页参数', async () => {
    const controller = new IntegrationController({} as OrgDeliveryOperationsService, {} as AuditService);
    const error = await controller
      .retry(EVENT_ID, 'wecom', 'retry-key-0001', { reason: 'anything' })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ response: { code: 'ORG_DELIVERY_CHANNEL_INVALID' } });
    expect(() => controller.list('manual_review', undefined, undefined, '1000'))
      .toThrow('limit 必须为 1..100');
  });

  it('人工重试失败也记录 R2 失败审计且不泄露异常详情', async () => {
    const retry = vi.fn().mockRejectedValue(new Error('上游返回的敏感详情'));
    const record = vi.fn().mockResolvedValue(undefined);
    const controller = new IntegrationController(
      { retry } as unknown as OrgDeliveryOperationsService,
      { record } as unknown as AuditService,
    );

    await expect(controller.retry(
      EVENT_ID, 'dingtalk', 'retry-key-0002', { reason: 'credentials_fixed' },
    )).rejects.toThrow('上游返回的敏感详情');
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failure',
      metadata: { reason: 'credentials_fixed' },
    }));
    expect(JSON.stringify(record.mock.calls)).not.toContain('上游返回的敏感详情');
  });
});
