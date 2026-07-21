import { BadRequestException } from '@nestjs/common';
import { REQUIRED_SCOPES_KEY } from '../identity/auth.decorators.js';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import type { OnboardingApplicationService } from './application/onboarding-application.service.js';
import { OnboardingController } from './onboarding.controller.js';

const ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y6';

function fixture() {
  const service = {
    recordTaskEvidence: vi.fn().mockResolvedValue({ onboarding: {
      id: ID, status: 'in_progress', version: 2,
    } }),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const controller = new OnboardingController(
    service as unknown as OnboardingApplicationService,
    audit as unknown as AuditService,
  );
  const response = { setHeader: vi.fn() };
  return { controller, service, audit, response };
}

describe('OnboardingController', () => {
  it('写接口声明精确 Scope', () => {
    expect(Reflect.getMetadata(
      REQUIRED_SCOPES_KEY,
      method('recordTaskEvidence'),
    )).toEqual(['erp:onboarding:task:complete']);
    expect(Reflect.getMetadata(
      REQUIRED_SCOPES_KEY,
      method('complete'),
    )).toEqual(['erp:onboarding:complete']);
  });

  it('人工接口拒绝自报身份核验和培训完成', async () => {
    const store = fixture();
    await expect(store.controller.recordTaskEvidence(
      ID, 'identity_verified', '"1"', 'onboarding-task-001',
      { evidenceId: ID }, store.response as never,
    )).rejects.toBeInstanceOf(BadRequestException);
    await expect(store.controller.recordTaskEvidence(
      ID, 'mandatory_training_completed', '"1"', 'onboarding-task-002',
      { evidenceId: ID }, store.response as never,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(store.service.recordTaskEvidence).not.toHaveBeenCalled();
  });
});

function method(name: 'recordTaskEvidence' | 'complete'): object {
  return Object.getOwnPropertyDescriptor(OnboardingController.prototype, name)?.value as object;
}
