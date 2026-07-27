import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import type { CareOccasionApplicationService } from './application/care-occasion-application.service.js';
import { CareOccasionController } from './care-occasion.controller.js';

describe('CareOccasionController', () => {
  it('本人偏好写入使用强版本与幂等键，审计不记录渠道或生日', async () => {
    const occasions = {
      updateMyPreference: vi.fn().mockResolvedValue({
        preference: {
          id: 'preference-001',
          birthdayEnabled: true,
          anniversaryEnabled: false,
          preferredChannels: ['feishu'],
          unsubscribed: false,
          version: 2,
        },
      }),
    };
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const setHeader = vi.fn();
    const response = { setHeader } as unknown as Response;
    const controller = new CareOccasionController(
      occasions as unknown as CareOccasionApplicationService,
      audit as unknown as AuditService,
    );
    await expect(controller.updateMine(
      '"1"',
      'care-preference-key-001',
      {
        birthdayEnabled: true,
        anniversaryEnabled: false,
        preferredChannels: ['feishu'],
      },
      response,
    )).resolves.toMatchObject({ preference: { version: 2 } });
    expect(occasions.updateMyPreference).toHaveBeenCalledWith(
      1,
      'care-preference-key-001',
      {
        birthdayEnabled: true,
        anniversaryEnabled: false,
        preferredChannels: ['feishu'],
      },
    );
    expect(setHeader).toHaveBeenCalledWith('ETag', '"2"');
    expect(JSON.stringify(audit.record.mock.calls)).not.toMatch(
      /feishu|birthdayMonthDay|scheduledAt|contact|body|evidence/iu,
    );
  });

  it('缺少强 If-Match 或幂等键时拒绝写入', async () => {
    const controller = new CareOccasionController(
      {} as CareOccasionApplicationService,
      { record: vi.fn() } as unknown as AuditService,
    );
    await expect(controller.updateMine(
      undefined,
      'care-preference-key-001',
      {
        birthdayEnabled: true,
        anniversaryEnabled: false,
        preferredChannels: ['email'],
      },
      {} as Response,
    )).rejects.toMatchObject({
      response: { code: 'CARE_IF_MATCH_REQUIRED' },
    });
    await expect(controller.createMine(
      undefined,
      {
        birthdayEnabled: true,
        anniversaryEnabled: false,
        preferredChannels: ['email'],
      },
      {} as Response,
    )).rejects.toMatchObject({
      response: { code: 'IDEMPOTENCY_KEY_REQUIRED' },
    });
  });
});
