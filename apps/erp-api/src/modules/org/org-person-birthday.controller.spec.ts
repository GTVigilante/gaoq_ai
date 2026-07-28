import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import type { OrgPersonBirthdayService } from './application/org-person-birthday.service.js';
import { OrgPersonBirthdayController } from './org-person-birthday.controller.js';

const PERSON_ID = '01J8ZQK7V0A2M4N6P8R0T2W4A1';
const IDENTITY_EVIDENCE_ID = '01J8ZQK7V0A2M4N6P8R0T2W4B2';
const BIRTHDAY_EVIDENCE_ID = '01J8ZQK7V0A2M4N6P8R0T2W4C3';
const BODY = Object.freeze({
  monthDay: '02-29',
  identityEvidenceId: IDENTITY_EVIDENCE_ID,
  birthdayEvidenceId: BIRTHDAY_EVIDENCE_ID,
});
const RESULT = Object.freeze({
  attestation: Object.freeze({
    personId: PERSON_ID,
    birthdayAttested: true as const,
    version: 2,
  }),
});

function fixture() {
  const birthdays = {
    attest: vi.fn().mockResolvedValue(RESULT),
  };
  const audit = {
    record: vi.fn().mockResolvedValue(undefined),
  };
  const response = {
    setHeader: vi.fn(),
  };
  const controller = new OrgPersonBirthdayController(
    birthdays as unknown as OrgPersonBirthdayService,
    audit as unknown as AuditService,
  );
  const logger = {
    error: vi.fn(),
  };
  Object.defineProperty(controller, 'logger', { value: logger });
  return {
    controller,
    birthdays,
    audit,
    response,
    logger,
  };
}

async function attest(
  store: ReturnType<typeof fixture>,
  overrides: {
    readonly id?: unknown;
    readonly ifMatch?: unknown;
    readonly key?: unknown;
    readonly body?: unknown;
  } = {},
) {
  return store.controller.attest(
    overrides.id === undefined ? PERSON_ID : overrides.id,
    overrides.ifMatch === undefined ? '"1"' : overrides.ifMatch,
    overrides.key === undefined ? 'birthday-attest-001' : overrides.key,
    overrides.body === undefined ? BODY : overrides.body,
    store.response as unknown as Response,
  );
}

describe('OrgPersonBirthdayController', () => {
  it('使用严格契约调用应用服务并只返回脱敏证明摘要', async () => {
    const store = fixture();
    const result = await attest(store);

    expect(result).toBe(RESULT);
    expect(store.birthdays.attest).toHaveBeenCalledWith(
      PERSON_ID,
      1,
      'birthday-attest-001',
      BODY,
    );
    const calls = store.birthdays.attest.mock.calls as unknown as readonly (
      readonly unknown[]
    )[];
    const request = calls[0]?.[3];
    expect(Object.isFrozen(request)).toBe(true);
    expect(store.response.setHeader).toHaveBeenCalledWith('ETag', '"2"');
    expect(store.audit.record).toHaveBeenCalledWith({
      action: 'org.person.birthday.attest',
      resourceType: 'org_person',
      resourceId: PERSON_ID,
      riskLevel: 'R2',
      outcome: 'success',
      metadata: {
        birthdayAttested: true,
        version: 2,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/02-29|birthday-evidence|identity-evidence/iu);
    expect(JSON.stringify(store.audit.record.mock.calls)).not.toContain('02-29');
    expect(JSON.stringify(store.audit.record.mock.calls)).not.toContain(BIRTHDAY_EVIDENCE_ID);
  });

  it.each([
    ['非字符串标识', 1],
    ['小写标识', PERSON_ID.toLowerCase()],
    ['非法标识', 'bad'],
  ])('%s在调用服务前失败关闭', async (_label, id) => {
    const store = fixture();
    await expect(attest(store, { id })).rejects.toMatchObject({
      response: { code: 'ORG_INVALID_ID' },
    });
    expect(store.birthdays.attest).not.toHaveBeenCalled();
    expect(store.audit.record).not.toHaveBeenCalled();
  });

  it.each([
    ['缺失版本', null],
    ['弱 ETag', 'W/"1"'],
    ['零版本', '"0"'],
    ['前导零', '"01"'],
    ['裸数字', '1'],
    ['非字符串', 1],
    ['最大安全整数', `"${Number.MAX_SAFE_INTEGER}"`],
    ['非安全整数', `"${Number.MAX_SAFE_INTEGER + 1}"`],
  ])('%s不能通过强 If-Match 校验', async (_label, ifMatch) => {
    const store = fixture();
    await expect(attest(store, { ifMatch })).rejects.toMatchObject({
      response: { code: 'ORG_IF_MATCH_REQUIRED' },
    });
    expect(store.birthdays.attest).not.toHaveBeenCalled();
  });

  it.each([
    ['缺失幂等键', null],
    ['非字符串', 1],
    ['过短', 'short'],
    ['包含空格', 'birthday attest 001'],
    ['超过上限', 'a'.repeat(129)],
  ])('%s不能通过幂等键白名单', async (_label, key) => {
    const store = fixture();
    await expect(attest(store, { key })).rejects.toMatchObject({
      response: { code: 'IDEMPOTENCY_KEY_REQUIRED' },
    });
    expect(store.birthdays.attest).not.toHaveBeenCalled();
  });

  it.each([
    ['空请求', null],
    ['数组请求', []],
    ['缺少月日', {
      identityEvidenceId: IDENTITY_EVIDENCE_ID,
      birthdayEvidenceId: BIRTHDAY_EVIDENCE_ID,
    }],
    ['未知字段', { ...BODY, tenantId: 'tenant-other' }],
    ['非法格式', { ...BODY, monthDay: '2-9' }],
    ['不存在日期', { ...BODY, monthDay: '02-30' }],
    ['非法身份凭据', { ...BODY, identityEvidenceId: 'bad' }],
    ['非法生日凭据', { ...BODY, birthdayEvidenceId: 'bad' }],
  ])('%s不能通过严格请求结构校验', async (_label, body) => {
    const store = fixture();
    await expect(attest(store, { body })).rejects.toMatchObject({
      response: { code: 'ORG_PERSON_BIRTHDAY_REQUEST_INVALID' },
    });
    expect(store.birthdays.attest).not.toHaveBeenCalled();
    expect(store.audit.record).not.toHaveBeenCalled();
  });

  it('业务失败写入脱敏失败审计并保留原异常', async () => {
    const store = fixture();
    const businessError = new Error('版本冲突');
    store.birthdays.attest.mockRejectedValue(businessError);

    await expect(attest(store)).rejects.toBe(businessError);
    expect(store.audit.record).toHaveBeenCalledWith({
      action: 'org.person.birthday.attest',
      resourceType: 'org_person',
      resourceId: PERSON_ID,
      riskLevel: 'R2',
      outcome: 'failure',
      metadata: { version: 1 },
    });
    expect(JSON.stringify(store.audit.record.mock.calls)).not.toContain('02-29');
  });

  it('业务失败后的审计故障不覆盖业务异常且日志保持低敏', async () => {
    const store = fixture();
    const businessError = new Error('自然人不存在');
    store.birthdays.attest.mockRejectedValue(businessError);
    store.audit.record.mockRejectedValue(new Error('审计不可用'));

    await expect(attest(store)).rejects.toBe(businessError);
    expect(store.logger.error).toHaveBeenCalledWith({
      code: 'ORG_PERSON_BIRTHDAY_ATTEST_FAILURE_AUDIT_FAILED',
      personId: PERSON_ID,
    });
    expect(JSON.stringify(store.logger.error.mock.calls)).not.toContain('02-29');
    expect(JSON.stringify(store.logger.error.mock.calls)).not.toContain(BIRTHDAY_EVIDENCE_ID);
  });

  it('业务已提交后的成功审计故障不改变响应或触发重做', async () => {
    const store = fixture();
    store.audit.record.mockRejectedValue(new Error('审计不可用'));

    await expect(attest(store)).resolves.toBe(RESULT);
    expect(store.birthdays.attest).toHaveBeenCalledOnce();
    expect(store.logger.error).toHaveBeenCalledWith({
      code: 'ORG_PERSON_BIRTHDAY_ATTEST_AUDIT_AFTER_COMMIT_FAILED',
      personId: PERSON_ID,
    });
    expect(store.response.setHeader).toHaveBeenCalledWith('ETag', '"2"');
  });
});
