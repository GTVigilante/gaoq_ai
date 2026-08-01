import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { CreateOrgEmployeeProvisioningRequestDto } from './org-employee-provisioning.dto.js';

/**
 * DTO 形态校验测试：直接调用 class-validator 的 validate，
 * whitelist/forbidNonWhitelisted 用例复现全局 ValidationPipe 配置（main.ts）。
 */

/** 构造合法请求负载。 */
function validPayload(): Record<string, unknown> {
  return {
    employeeId: 'emp:001-A_b.c',
    channel: 'dingtalk',
    contact: {
      email: 'Zhang.San@Example.com',
      mobile: { countryCode: '+86', subscriberNumber: '13800138000' },
    },
  };
}

/** 负载转 DTO 实例并执行校验，返回错误列表。 */
async function validatePayload(
  payload: Record<string, unknown>,
  options?: { whitelist?: boolean; forbidNonWhitelisted?: boolean },
) {
  const dto = plainToInstance(CreateOrgEmployeeProvisioningRequestDto, payload);
  return validate(dto, options);
}

describe('CreateOrgEmployeeProvisioningRequestDto', () => {
  it('合法负载（email + mobile）校验通过', async () => {
    const errors = await validatePayload(validPayload());
    expect(errors).toHaveLength(0);
  });

  it('仅提供 email 校验通过（至少一项联系方式由服务层校验）', async () => {
    const payload = validPayload();
    payload.contact = { email: 'a@example.com' };
    const errors = await validatePayload(payload);
    expect(errors).toHaveLength(0);
  });

  it('仅提供 mobile 校验通过', async () => {
    const payload = validPayload();
    payload.contact = {
      mobile: { countryCode: '+852', subscriberNumber: '91234567' },
    };
    const errors = await validatePayload(payload);
    expect(errors).toHaveLength(0);
  });

  it('channel 为 feishu 校验通过', async () => {
    const payload = { ...validPayload(), channel: 'feishu' };
    const errors = await validatePayload(payload);
    expect(errors).toHaveLength(0);
  });

  it('employeeId 含非法字符被拒绝', async () => {
    const payload = { ...validPayload(), employeeId: 'emp#001' };
    const errors = await validatePayload(payload);
    expect(errors.some((error) => error.property === 'employeeId')).toBe(true);
  });

  it('employeeId 超长（>128）被拒绝', async () => {
    const payload = { ...validPayload(), employeeId: 'a'.repeat(129) };
    const errors = await validatePayload(payload);
    expect(errors.some((error) => error.property === 'employeeId')).toBe(true);
  });

  it('channel 非枚举值被拒绝', async () => {
    const payload = { ...validPayload(), channel: 'wechat' };
    const errors = await validatePayload(payload);
    expect(errors.some((error) => error.property === 'channel')).toBe(true);
  });

  it('email 非法被拒绝', async () => {
    const payload = validPayload();
    payload.contact = { email: 'not-an-email' };
    const errors = await validatePayload(payload);
    expect(errors).not.toHaveLength(0);
  });

  it('email 超长（>254）被拒绝', async () => {
    const payload = validPayload();
    payload.contact = { email: `${'a'.repeat(246)}@example.com` };
    const errors = await validatePayload(payload);
    expect(errors).not.toHaveLength(0);
  });

  it('countryCode 形态非法被拒绝（缺 +、首位 0、超长）', async () => {
    for (const countryCode of ['86', '+086', '+12345']) {
      const payload = validPayload();
      payload.contact = { mobile: { countryCode, subscriberNumber: '13800138000' } };
      const errors = await validatePayload(payload);
      expect(errors).not.toHaveLength(0);
    }
  });

  it('subscriberNumber 形态非法被拒绝（首位 0、过短、非数字）', async () => {
    for (const subscriberNumber of ['01380013800', '12345', '1380013800a']) {
      const payload = validPayload();
      payload.contact = { mobile: { countryCode: '+86', subscriberNumber } };
      const errors = await validatePayload(payload);
      expect(errors).not.toHaveLength(0);
    }
  });

  it('contact 缺失被拒绝', async () => {
    const payload = validPayload();
    delete payload.contact;
    const errors = await validatePayload(payload);
    expect(errors.some((error) => error.property === 'contact')).toBe(true);
  });

  it('顶层额外字段在 whitelist+forbidNonWhitelisted 下被拒绝', async () => {
    const payload = { ...validPayload(), hackerField: 'x' };
    const errors = await validatePayload(payload, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors.some((error) => error.property === 'hackerField')).toBe(true);
  });

  it('contact 内额外字段在 whitelist+forbidNonWhitelisted 下被拒绝', async () => {
    const payload = validPayload();
    payload.contact = { email: 'a@example.com', homeAddress: '某市某路' };
    const errors = await validatePayload(payload, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    const contactError = errors.find((error) => error.property === 'contact');
    expect(
      contactError?.children?.some((child) => child.property === 'homeAddress'),
    ).toBe(true);
  });

  it('mobile 内额外字段在 whitelist+forbidNonWhitelisted 下被拒绝', async () => {
    const payload = validPayload();
    payload.contact = {
      mobile: { countryCode: '+86', subscriberNumber: '13800138000', imei: '123' },
    };
    const errors = await validatePayload(payload, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    const contactError = errors.find((error) => error.property === 'contact');
    const mobileError = contactError?.children?.find(
      (child) => child.property === 'mobile',
    );
    expect(mobileError?.children?.some((child) => child.property === 'imei')).toBe(true);
  });
});
