import { BadRequestException, Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { REQUIRED_SCOPES_KEY } from '../identity/auth.decorators.js';
import type { OnboardingApplicationService } from './application/onboarding-application.service.js';
import { OnboardingController } from './onboarding.controller.js';

const ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y6';
const summary = Object.freeze({
  id: ID,
  offerId: ID,
  applicationId: ID,
  candidateId: ID,
  departmentId: ID,
  jobLevelId: ID,
  proposedStartDate: '2026-08-01',
  status: 'in_progress',
  tasks: {},
  version: 2,
  completionEvidenceId: null,
  employmentId: null,
  createdAt: '2026-07-21T00:00:00.000Z',
  updatedAt: '2026-07-21T00:00:00.000Z',
});

function fixture() {
  const service = {
    createFromOffer: vi.fn().mockResolvedValue({ onboarding: summary }),
    get: vi.fn().mockResolvedValue(summary),
    recordTaskEvidence: vi.fn().mockResolvedValue({ onboarding: summary }),
    syncContractEvidence: vi.fn().mockResolvedValue({ onboarding: summary }),
    complete: vi.fn().mockResolvedValue({ onboarding: {
      ...summary, status: 'completed', version: 8,
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
  it.each([
    ['create', 'erp:onboarding:create'],
    ['get', 'erp:onboarding:read'],
    ['recordTaskEvidence', 'erp:onboarding:task:complete'],
    ['syncContract', 'erp:onboarding:contract:attest'],
    ['complete', 'erp:onboarding:complete'],
  ] as const)('%s 接口声明精确 Scope', (name, scope) => {
    expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, method(name))).toEqual([scope]);
  });

  it('创建校验 ULID 与幂等键，返回 ETag 并写 R2 审计', async () => {
    const store = fixture();

    const result = await store.controller.create(
      ID,
      'onboarding-create-001',
      store.response as never,
    );

    expect(result).toEqual({ onboarding: summary });
    expect(store.service.createFromOffer).toHaveBeenCalledWith(ID, 'onboarding-create-001');
    expect(store.response.setHeader).toHaveBeenCalledWith('ETag', '"2"');
    expect(store.audit.record).toHaveBeenCalledWith({
      action: 'onboarding.instance.create',
      resourceType: 'onboarding_instance',
      resourceId: ID,
      riskLevel: 'R2',
      outcome: 'success',
      metadata: { status: 'in_progress', version: 2 },
    });
  });

  it.each([
    ['', 'onboarding-create-001', 'ONBOARDING_ID_INVALID'],
    ['not-an-ulid', 'onboarding-create-001', 'ONBOARDING_ID_INVALID'],
    [ID, undefined, 'IDEMPOTENCY_KEY_REQUIRED'],
    [ID, '', 'IDEMPOTENCY_KEY_REQUIRED'],
  ] as const)('创建拒绝非法边界输入 %#', async (id, key, code) => {
    const store = fixture();

    await expect(store.controller.create(
      id,
      key,
      store.response as never,
    )).rejects.toMatchObject({ response: { code } });

    expect(store.service.createFromOffer).not.toHaveBeenCalled();
    expect(store.audit.record).not.toHaveBeenCalled();
  });

  it('读取返回强 ETag，不产生写审计', async () => {
    const store = fixture();

    const result = await store.controller.get(ID, store.response as never);

    expect(result).toBe(summary);
    expect(store.service.get).toHaveBeenCalledWith(ID);
    expect(store.response.setHeader).toHaveBeenCalledWith('ETag', '"2"');
    expect(store.audit.record).not.toHaveBeenCalled();
  });

  it('读取拒绝非 ULID 且不调用应用服务', async () => {
    const store = fixture();

    await expect(store.controller.get('123', store.response as never))
      .rejects.toBeInstanceOf(BadRequestException);

    expect(store.service.get).not.toHaveBeenCalled();
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

  it.each([
    ['materials_verified'],
    ['org_assignment_verified'],
  ] as const)('人工接口允许 %s 并固化任务审计元数据', async (taskCode) => {
    const store = fixture();
    const body = {
      evidenceId: ID,
      ...(taskCode === 'org_assignment_verified' ? { orgPositionId: ID } : {}),
    };

    const result = await store.controller.recordTaskEvidence(
      ID,
      taskCode,
      '"1"',
      `onboarding-task-${taskCode}`,
      body,
      store.response as never,
    );

    expect(result).toEqual({ onboarding: summary });
    expect(store.service.recordTaskEvidence).toHaveBeenCalledWith(
      ID,
      1,
      `onboarding-task-${taskCode}`,
      {
        taskCode,
        evidenceId: ID,
        ...(taskCode === 'org_assignment_verified' ? { orgPositionId: ID } : {}),
      },
    );
    expect(store.response.setHeader).toHaveBeenCalledWith('ETag', '"2"');
    expect(store.audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'onboarding.task.record_evidence',
      riskLevel: 'R2',
      metadata: { status: 'in_progress', version: 2, taskCode },
    }));
  });

  it.each([
    [undefined],
    [''],
    ['1'],
    ['W/"1"'],
    ['"0"'],
    ['"9007199254740992"'],
  ] as const)('写接口拒绝非法 If-Match：%s', async (ifMatch) => {
    const store = fixture();

    await expect(store.controller.recordTaskEvidence(
      ID,
      'materials_verified',
      ifMatch,
      'onboarding-task-version-invalid',
      { evidenceId: ID },
      store.response as never,
    )).rejects.toMatchObject({
      response: { code: 'ONBOARDING_IF_MATCH_REQUIRED' },
    });

    expect(store.service.recordTaskEvidence).not.toHaveBeenCalled();
  });

  it('任务证据接口拒绝缺失幂等键', async () => {
    const store = fixture();

    await expect(store.controller.recordTaskEvidence(
      ID,
      'materials_verified',
      '"1"',
      undefined,
      { evidenceId: ID },
      store.response as never,
    )).rejects.toMatchObject({
      response: { code: 'IDEMPOTENCY_KEY_REQUIRED' },
    });

    expect(store.service.recordTaskEvidence).not.toHaveBeenCalled();
  });

  it('合同同步使用强版本与幂等键并写 R1 审计', async () => {
    const store = fixture();

    const result = await store.controller.syncContract(
      ID,
      '"2"',
      'onboarding-contract-001',
      store.response as never,
    );

    expect(result).toEqual({ onboarding: summary });
    expect(store.service.syncContractEvidence).toHaveBeenCalledWith(
      ID,
      2,
      'onboarding-contract-001',
    );
    expect(store.audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'onboarding.contract.sync',
      riskLevel: 'R1',
      outcome: 'success',
    }));
  });

  it('完成接口返回终态版本并写 R3 审计', async () => {
    const store = fixture();

    const result = await store.controller.complete(
      ID,
      '"6"',
      'onboarding-complete-001',
      store.response as never,
    );

    expect(result.onboarding).toMatchObject({ status: 'completed', version: 8 });
    expect(store.service.complete).toHaveBeenCalledWith(ID, 6, 'onboarding-complete-001');
    expect(store.response.setHeader).toHaveBeenCalledWith('ETag', '"8"');
    expect(store.audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'onboarding.instance.complete',
      riskLevel: 'R3',
      metadata: { status: 'completed', version: 8 },
    }));
  });

  it('业务提交后的审计故障只告警，不把成功终态回写为失败', async () => {
    const store = fixture();
    store.audit.record.mockRejectedValue(new Error('audit unavailable'));
    const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const result = await store.controller.complete(
      ID,
      '"6"',
      'onboarding-complete-audit-failed',
      store.response as never,
    );

    expect(result.onboarding).toMatchObject({ status: 'completed', version: 8 });
    expect(store.service.complete).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith({
      code: 'ONBOARDING_AUDIT_AFTER_COMMIT_FAILED',
      action: 'onboarding.instance.complete',
      resourceId: ID,
      riskLevel: 'R3',
    });
  });

  it('业务失败时保留原始异常且不得伪造成功审计', async () => {
    const store = fixture();
    const failure = new Error('employment provisioning unavailable');
    store.service.complete.mockRejectedValue(failure);

    await expect(store.controller.complete(
      ID,
      '"6"',
      'onboarding-complete-failed',
      store.response as never,
    )).rejects.toBe(failure);

    expect(store.audit.record).not.toHaveBeenCalled();
    expect(store.response.setHeader).not.toHaveBeenCalled();
  });
});

function method(
  name: 'create' | 'get' | 'recordTaskEvidence' | 'syncContract' | 'complete',
): object {
  return Object.getOwnPropertyDescriptor(OnboardingController.prototype, name)?.value as object;
}
