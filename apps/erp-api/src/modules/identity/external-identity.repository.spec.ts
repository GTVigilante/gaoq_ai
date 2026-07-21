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
  provider: 'dingtalk',
  externalTenantId: 'corp-001',
  unionId: 'union-001',
  externalUserId: 'ext-user-001',
};

describe('ExternalIdentityRepository', () => {
  describe('findBoundByExternalProfile', () => {
    it('查询条件必须同时包含 tenantId 与 bound 状态，动态值作为标量传入', async () => {
      const model = createModelMock();
      const exec = vi.fn().mockResolvedValue(null);
      model.findOne.mockReturnValue({ exec });
      const repository = createRepository(model);

      await repository.findBoundByExternalProfile('tenant-001', profile);

      expect(model.findOne).toHaveBeenCalledWith({
        tenantId: 'tenant-001',
        provider: 'dingtalk',
        externalTenantId: 'corp-001',
        status: 'bound',
        unionId: 'union-001',
        externalUserId: 'ext-user-001',
      });
    });

    it('命中时返回绑定文档', async () => {
      const model = createModelMock();
      const doc = { tenantId: 'tenant-001', actorId: 'employee-001', status: 'bound' };
      model.findOne.mockReturnValue({ exec: vi.fn().mockResolvedValue(doc) });
      const repository = createRepository(model);

      const result = await repository.findBoundByExternalProfile('tenant-001', profile);

      expect(result).toBe(doc);
    });

    it('找不到时返回 null', async () => {
      const model = createModelMock();
      model.findOne.mockReturnValue({ exec: vi.fn().mockResolvedValue(null) });
      const repository = createRepository(model);

      const result = await repository.findBoundByExternalProfile('tenant-404', profile);

      expect(result).toBeNull();
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
});
