import { model } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { AccessProfileSchema } from './access-profile.schema.js';

const AccessProfileValidationModel = model(
  'AccessProfileValidation',
  AccessProfileSchema,
);

const validProfile = () => ({
  tenantId: 'tenant-001',
  actorId: 'actor-001',
  employeeId: 'employee-001',
  status: 'active',
  roleCodes: ['employee'],
  scopes: ['erp:identity:profile:read'],
  departmentIds: ['department-001'],
  version: 1,
});

describe('AccessProfileSchema', () => {
  it('拒绝超过授权集合上限的快照', async () => {
    const document = new AccessProfileValidationModel({
      ...validProfile(),
      roleCodes: Array.from({ length: 101 }, (_, index) => `role-${index}`),
    });

    await expect(document.validate()).rejects.toThrow('数组长度不能超过 100');
  });

  it('拒绝空白授权编码与非正整数版本', async () => {
    const document = new AccessProfileValidationModel({
      ...validProfile(),
      scopes: ['   '],
      version: 0,
    });

    await expect(document.validate()).rejects.toThrow();
  });

  it('拒绝不符合 erp:{domain}:{resource}:{action} 格式的授权范围', async () => {
    const document = new AccessProfileValidationModel({
      ...validProfile(),
      scopes: ['org:read'],
    });

    await expect(document.validate()).rejects.toThrow();
  });

  it('拒绝操作符形态标识、非法数组元素与超大版本', async () => {
    for (const override of [
      { tenantId: '$where' },
      { actorId: '$ne' },
      { employeeId: '$gt' },
      { roleCodes: ['$bad'] },
      { departmentIds: ['$bad'] },
      { version: 1_000_000_001 },
    ]) {
      await expect(new AccessProfileValidationModel({
        ...validProfile(), ...override,
      }).validate()).rejects.toThrow();
    }
  });
});
