import type { ClientSession, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import {
  ExternalIdentityRepository,
  type ExternalProfile,
} from './external-identity.repository.js';
import type { ExternalIdentityDocument } from './external-identity.schema.js';

/** 构造 mock Model：findOne 返回带 exec 的查询对象，updateOne 直接返回结果。 */
const createModelMock = () => ({
  findOne: vi.fn(),
  find: vi.fn(),
  updateOne: vi.fn(),
  updateMany: vi.fn(),
});

const createRepository = (model: ReturnType<typeof createModelMock>) =>
  new ExternalIdentityRepository(model as unknown as Model<ExternalIdentityDocument>);

const profile: ExternalProfile = {
  provider: 'feishu',
  externalTenantId: 'corp-001',
  unionId: 'union-001',
  externalUserId: 'ext-user-001',
};

const createBoundRecord = () => ({
  tenantId: 'tenant-001',
  provider: 'feishu',
  externalTenantId: 'corp-001',
  unionId: 'union-001',
  externalUserId: 'ext-user-001',
  actorId: 'actor-001',
  employeeId: 'employee-001',
  status: 'bound',
});

const createLeanQuery = (result: unknown) => ({
  lean: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(result) }),
});

describe('ExternalIdentityRepository', () => {
  describe('findBoundByExternalProfile', () => {
    it('查询条件必须同时包含 tenantId 与 bound 状态，动态值作为标量传入', async () => {
      const model = createModelMock();
      model.findOne.mockReturnValue(createLeanQuery(null));
      const repository = createRepository(model);

      await repository.findBoundByExternalProfile('tenant-001', profile);

      expect(model.findOne).toHaveBeenCalledWith(
        {
          tenantId: 'tenant-001',
          provider: 'feishu',
          externalTenantId: 'corp-001',
          status: 'bound',
          unionId: 'union-001',
          externalUserId: 'ext-user-001',
        },
        {
          tenantId: 1, provider: 1, externalTenantId: 1, unionId: 1,
          externalUserId: 1, loginOpenId: 1, actorId: 1, employeeId: 1, status: 1, _id: 0,
        },
      );
    });

    it('命中时返回通过完整性校验的冻结最小映射', async () => {
      const model = createModelMock();
      const doc = createBoundRecord();
      model.findOne.mockReturnValue(createLeanQuery(doc));
      const repository = createRepository(model);

      const result = await repository.findBoundByExternalProfile('tenant-001', profile);

      expect(result).toEqual({
        tenantId: 'tenant-001',
        provider: 'feishu',
        externalTenantId: 'corp-001',
        unionId: 'union-001',
        externalUserId: 'ext-user-001',
        actorId: 'actor-001',
        employeeId: 'employee-001',
      });
      expect(result).not.toBe(doc);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('找不到时返回 null', async () => {
      const model = createModelMock();
      model.findOne.mockReturnValue(createLeanQuery(null));
      const repository = createRepository(model);

      const result = await repository.findBoundByExternalProfile('tenant-404', profile);

      expect(result).toBeNull();
    });

    it('查询前拒绝操作符、未知平台与非法外部标识', async () => {
      const model = createModelMock();
      const repository = createRepository(model);
      await expect(repository.findBoundByExternalProfile('$where', profile)).rejects.toThrow();
      await expect(repository.findBoundByExternalProfile('tenant-001', {
        ...profile, provider: 'unknown' as ExternalProfile['provider'],
      })).rejects.toThrow('提供者非法');
      await expect(repository.findBoundByExternalProfile('tenant-001', {
        ...profile, unionId: '$bad',
      })).rejects.toThrow('外部身份标识非法');
      expect(model.findOne).not.toHaveBeenCalled();
    });

    it.each([
      { field: 'tenantId', value: 'tenant-attacker' },
      { field: 'provider', value: 'dingtalk' },
      { field: 'externalTenantId', value: 'corp-attacker' },
      { field: 'unionId', value: 'union-attacker' },
      { field: 'externalUserId', value: 'user-attacker' },
      { field: 'actorId', value: '$bad' },
      { field: 'status', value: 'disabled' },
    ])('拒绝受损持久化字段 $field', async ({ field, value }) => {
      const model = createModelMock();
      model.findOne.mockReturnValue(createLeanQuery({ ...createBoundRecord(), [field]: value }));
      await expect(createRepository(model).findBoundByExternalProfile(
        'tenant-001', profile,
      )).rejects.toThrow();
    });

    it('钉钉首次扫码按 corpId+unionId 原子登记 openId，通讯录 userid 保持不变', async () => {
      const model = createModelMock();
      const dingtalkProfile: ExternalProfile = {
        provider: 'dingtalk', externalTenantId: 'corp-001',
        unionId: 'union-001', externalUserId: 'open-id-001',
      };
      model.findOne.mockReturnValue(createLeanQuery({
        ...createBoundRecord(),
        provider: 'dingtalk',
        externalUserId: 'userid-001',
        loginOpenId: null,
      }));
      model.updateOne.mockResolvedValue({ modifiedCount: 1 });
      const result = await createRepository(model).findBoundByExternalProfile(
        'tenant-001', dingtalkProfile,
      );
      expect(model.findOne).toHaveBeenCalledWith(
        {
          tenantId: 'tenant-001', provider: 'dingtalk', externalTenantId: 'corp-001',
          status: 'bound', unionId: 'union-001',
        },
        {
          tenantId: 1, provider: 1, externalTenantId: 1, unionId: 1,
          externalUserId: 1, loginOpenId: 1, actorId: 1, employeeId: 1, status: 1, _id: 0,
        },
      );
      expect(model.updateOne).toHaveBeenCalledWith(
        {
          tenantId: 'tenant-001', provider: 'dingtalk', externalTenantId: 'corp-001',
          status: 'bound', unionId: 'union-001', externalUserId: 'userid-001',
          loginOpenId: null,
        },
        { $set: { loginOpenId: 'open-id-001' } },
        { runValidators: true },
      );
      expect(result).toMatchObject({
        provider: 'dingtalk', externalUserId: 'open-id-001', employeeId: 'employee-001',
      });
    });

    it('钉钉后续扫码必须精确匹配已登记 openId', async () => {
      const model = createModelMock();
      model.findOne.mockReturnValue(createLeanQuery({
        ...createBoundRecord(), provider: 'dingtalk', externalUserId: 'userid-001',
        loginOpenId: 'open-id-001',
      }));
      const repository = createRepository(model);
      await expect(repository.findBoundByExternalProfile('tenant-001', {
        provider: 'dingtalk', externalTenantId: 'corp-001', unionId: 'union-001',
        externalUserId: 'open-id-001',
      })).resolves.toMatchObject({ externalUserId: 'open-id-001' });
      expect(model.updateOne).not.toHaveBeenCalled();

      await expect(repository.findBoundByExternalProfile('tenant-001', {
        provider: 'dingtalk', externalTenantId: 'corp-001', unionId: 'union-001',
        externalUserId: 'open-id-attacker',
      })).rejects.toThrow('持久化记录受损');
    });

    it('钉钉首次登记并发丢失时重读并验证胜出的 openId', async () => {
      const model = createModelMock();
      model.findOne
        .mockReturnValueOnce(createLeanQuery({
          ...createBoundRecord(), provider: 'dingtalk', externalUserId: 'userid-001',
          loginOpenId: null,
        }))
        .mockReturnValueOnce(createLeanQuery({
          ...createBoundRecord(), provider: 'dingtalk', externalUserId: 'userid-001',
          loginOpenId: 'open-id-001',
        }));
      model.updateOne.mockResolvedValue({ modifiedCount: 0 });
      await expect(createRepository(model).findBoundByExternalProfile('tenant-001', {
        provider: 'dingtalk', externalTenantId: 'corp-001', unionId: 'union-001',
        externalUserId: 'open-id-001',
      })).resolves.toMatchObject({ externalUserId: 'open-id-001' });
      expect(model.findOne).toHaveBeenCalledTimes(2);
    });

    it('钉钉 openId 唯一索引冲突失败关闭', async () => {
      const model = createModelMock();
      model.findOne.mockReturnValue(createLeanQuery({
        ...createBoundRecord(), provider: 'dingtalk', externalUserId: 'userid-001',
        loginOpenId: null,
      }));
      model.updateOne.mockRejectedValue({ code: 11_000 });
      await expect(createRepository(model).findBoundByExternalProfile('tenant-001', {
        provider: 'dingtalk', externalTenantId: 'corp-001', unionId: 'union-001',
        externalUserId: 'open-id-001',
      })).rejects.toThrow('持久化记录受损');
    });
  });

  describe('disable', () => {
    it('更新条件强制包含 tenantId 与 bound 状态，仅停用指定记录', async () => {
      const model = createModelMock();
      model.updateOne.mockResolvedValue({ modifiedCount: 1 });
      const repository = createRepository(model);

      const ok = await repository.disable('tenant-001', 'binding-001');

      expect(model.updateOne).toHaveBeenCalledWith(
        { _id: 'binding-001', tenantId: 'tenant-001', status: 'bound' },
        { $set: { status: 'disabled' } },
      );
      expect(ok).toBe(true);
    });

    it('跨租户或不存在的记录不会命中，返回 false', async () => {
      const model = createModelMock();
      model.updateOne.mockResolvedValue({ modifiedCount: 0 });
      const repository = createRepository(model);

      const ok = await repository.disable('tenant-999', 'binding-001');

      expect(model.updateOne).toHaveBeenCalledWith(
        { _id: 'binding-001', tenantId: 'tenant-999', status: 'bound' },
        { $set: { status: 'disabled' } },
      );
      expect(ok).toBe(false);
    });

    it('拒绝非法租户或绑定标识且不写库', async () => {
      const model = createModelMock();
      const repository = createRepository(model);
      await expect(repository.disable('$where', 'binding-001')).rejects.toThrow();
      await expect(repository.disable('tenant-001', '$ne')).rejects.toThrow();
      expect(model.updateOne).not.toHaveBeenCalled();
    });
  });

  it('离职反查使用固定租户/员工投影、事务与冻结去重结果', async () => {
    const model = createModelMock();
    const mongoSession = {} as ClientSession;
    const exec = vi.fn().mockResolvedValue([
      { actorId: 'actor-002' }, { actorId: 'actor-001' }, { actorId: 'actor-002' },
    ]);
    const lean = vi.fn().mockReturnValue({ exec });
    const session = vi.fn().mockReturnValue({ lean });
    const select = vi.fn().mockReturnValue({ session });
    model.find.mockReturnValue({ select });
    const result = await createRepository(model).findActorIdsByEmployee(
      'tenant-001', 'employee-001', mongoSession,
    );
    expect(model.find).toHaveBeenCalledWith({ tenantId: 'tenant-001', employeeId: 'employee-001' });
    expect(select).toHaveBeenCalledWith('actorId -_id');
    expect(session).toHaveBeenCalledWith(mongoSession);
    expect(result).toEqual(['actor-001', 'actor-002']);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('离职反查遇到受损主体时失败关闭', async () => {
    const model = createModelMock();
    const exec = vi.fn().mockResolvedValue([{ actorId: '$bad' }]);
    model.find.mockReturnValue({
      select: () => ({ session: () => ({ lean: () => ({ exec }) }) }),
    });
    await expect(createRepository(model).findActorIdsByEmployee(
      'tenant-001', 'employee-001', {} as ClientSession,
    )).rejects.toThrow('标识非法');
  });

  it('离职仅停用租户内员工的 bound 身份并返回修改数量', async () => {
    const model = createModelMock();
    model.updateMany.mockResolvedValue({ modifiedCount: 2 });
    const mongoSession = {} as ClientSession;
    await expect(createRepository(model).disableAllByEmployee(
      'tenant-001', 'employee-001', mongoSession,
    )).resolves.toBe(2);
    expect(model.updateMany).toHaveBeenCalledWith(
      { tenantId: 'tenant-001', employeeId: 'employee-001', status: 'bound' },
      { $set: { status: 'disabled' } },
      { session: mongoSession },
    );
  });

  it('离职身份原语拒绝操作符形态标识且不访问数据库', async () => {
    const model = createModelMock();
    await expect(createRepository(model).findActorIdsByEmployee(
      '$where', 'employee-001', {} as ClientSession,
    )).rejects.toThrow('标识非法');
    expect(model.find).not.toHaveBeenCalled();
  });

  it('开户前按租户、平台租户和员工精确查找 bound 身份', async () => {
    const model = createModelMock();
    const exec = vi.fn().mockResolvedValue({
      actorId: 'actor-001', externalUserId: 'external-user-001', unionId: 'union-001',
    });
    const lean = vi.fn().mockReturnValue({ exec });
    model.findOne.mockReturnValue({ lean });
    const result = await createRepository(model).findBoundByEmployee(
      'tenant-001', 'feishu', 'external-tenant-001', 'employee-001',
    );
    expect(model.findOne).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-001', provider: 'feishu', externalTenantId: 'external-tenant-001',
        employeeId: 'employee-001', status: 'bound',
      },
      { actorId: 1, externalUserId: 1, unionId: 1, _id: 0 },
    );
    expect(result).toEqual({
      actorId: 'actor-001', externalUserId: 'external-user-001', unionId: 'union-001',
    });
  });

  it('开户前未命中返回 null，非法平台或受损投影失败关闭', async () => {
    const model = createModelMock();
    model.findOne
      .mockReturnValueOnce(createLeanQuery(null))
      .mockReturnValueOnce(createLeanQuery({
        actorId: '$bad', externalUserId: 'external-user-001', unionId: 'union-001',
      }));
    const repository = createRepository(model);
    await expect(repository.findBoundByEmployee(
      'tenant-001', 'feishu', 'external-tenant-001', 'employee-001',
    )).resolves.toBeNull();
    await expect(repository.findBoundByEmployee(
      'tenant-001', 'feishu', 'external-tenant-001', 'employee-001',
    )).rejects.toThrow('标识非法');
    await expect(repository.findBoundByEmployee(
      'tenant-001', 'unknown' as 'feishu', 'external-tenant-001', 'employee-001',
    )).rejects.toThrow('提供者非法');
  });

  it('批量绑定状态只查询可信可见员工并返回冻结排序标识', async () => {
    const model = createModelMock();
    const exec = vi.fn().mockResolvedValue([
      {
        tenantId: 'tenant-001', provider: 'dingtalk', externalTenantId: 'corp-001',
        employeeId: 'employee-002', status: 'bound',
      },
      {
        tenantId: 'tenant-001', provider: 'dingtalk', externalTenantId: 'corp-001',
        employeeId: 'employee-001', status: 'bound',
      },
    ]);
    model.find.mockReturnValue({ lean: () => ({ exec }) });
    const result = await createRepository(model).findBoundEmployeeIds(
      'tenant-001', 'dingtalk', 'corp-001', ['employee-001', 'employee-002'],
    );
    expect(model.find).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-001', provider: 'dingtalk', externalTenantId: 'corp-001',
        employeeId: { $in: ['employee-001', 'employee-002'] }, status: 'bound',
      },
      {
        tenantId: 1, provider: 1, externalTenantId: 1, employeeId: 1, status: 1, _id: 0,
      },
    );
    expect(result).toEqual(['employee-001', 'employee-002']);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('批量绑定状态拒绝越界范围、空范围直接返回且受损回读失败关闭', async () => {
    const model = createModelMock();
    const repository = createRepository(model);
    await expect(repository.findBoundEmployeeIds(
      'tenant-001', 'dingtalk', 'corp-001', [],
    )).resolves.toEqual([]);
    expect(model.find).not.toHaveBeenCalled();
    await expect(repository.findBoundEmployeeIds(
      'tenant-001', 'dingtalk', 'corp-001', ['employee-001', 'employee-001'],
    )).rejects.toThrow('员工范围非法');
    await expect(repository.findBoundEmployeeIds(
      'tenant-001', 'unknown' as 'dingtalk', 'corp-001', ['employee-001'],
    )).rejects.toThrow('提供者非法');

    model.find.mockReturnValue({
      lean: () => ({
        exec: () => Promise.resolve([{
          tenantId: 'tenant-attacker', provider: 'dingtalk', externalTenantId: 'corp-001',
          employeeId: 'employee-001', status: 'bound',
        }]),
      }),
    });
    await expect(repository.findBoundEmployeeIds(
      'tenant-001', 'dingtalk', 'corp-001', ['employee-001'],
    )).rejects.toThrow('持久化记录受损');
  });

  it('开户绑定用全部不可变身份做幂等 upsert 并透传事务', async () => {
    const model = createModelMock();
    model.updateOne.mockResolvedValue({ modifiedCount: 0 });
    const session = {} as ClientSession;
    const identity = {
      provider: 'feishu' as const,
      externalTenantId: 'external-tenant-001',
      unionId: 'union-001',
      externalUserId: 'external-user-001',
      actorId: 'actor-001',
      employeeId: 'employee-001',
    };
    await createRepository(model).bindProvisioned('tenant-001', identity, session);
    expect(model.updateOne).toHaveBeenCalledWith(
      { tenantId: 'tenant-001', ...identity, status: 'bound' },
      {
        $setOnInsert: {
          tenantId: 'tenant-001', ...identity, loginOpenId: null, status: 'bound',
        },
      },
      { upsert: true, session, runValidators: true },
    );
  });

  it('开户绑定拒绝未知平台与非法外部身份且不写库', async () => {
    const model = createModelMock();
    const repository = createRepository(model);
    const valid = {
      provider: 'feishu' as const,
      externalTenantId: 'external-tenant-001',
      unionId: 'union-001',
      externalUserId: 'external-user-001',
      actorId: 'actor-001',
      employeeId: 'employee-001',
    };
    await expect(repository.bindProvisioned(
      'tenant-001', { ...valid, provider: 'unknown' as 'feishu' }, {} as ClientSession,
    )).rejects.toThrow('提供者非法');
    await expect(repository.bindProvisioned(
      'tenant-001', { ...valid, unionId: '$bad' }, {} as ClientSession,
    )).rejects.toThrow('开户外部身份标识非法');
    expect(model.updateOne).not.toHaveBeenCalled();
  });
});
