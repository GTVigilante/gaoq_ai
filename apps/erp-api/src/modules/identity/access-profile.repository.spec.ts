import type { ClientSession, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { AccessProfileRepository } from './access-profile.repository.js';
import type { AccessProfileDocument } from './access-profile.schema.js';

/** 构造 mock Model：findOne 返回 select/lean/exec 链，updateOne 直接返回结果。 */
const createModelMock = () => ({
  findOne: vi.fn(),
  updateOne: vi.fn(),
});

const createRepository = (model: ReturnType<typeof createModelMock>) =>
  new AccessProfileRepository(model as unknown as Model<AccessProfileDocument>);

/** 构造 lean 链式查询 mock。 */
const createQueryMock = (resolved: unknown) => {
  const exec = vi.fn().mockResolvedValue(resolved);
  const lean = vi.fn().mockReturnValue({ exec });
  const select = vi.fn().mockReturnValue({ lean });
  return { select, lean, exec };
};

/** 样例快照文档（lean 后的普通对象形态）。 */
const createDoc = () => ({
  tenantId: 'tenant-001',
  actorId: 'actor-001',
  employeeId: 'employee-001',
  status: 'active',
  roleCodes: ['admin'],
  scopes: ['order:read'],
  departmentIds: ['dept-001'],
  version: 3,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
});

describe('AccessProfileRepository', () => {
  describe('resolveActive', () => {
    it('查询条件必须同时包含 tenantId、actorId 与 active 状态，动态值作为标量传入', async () => {
      const model = createModelMock();
      const query = createQueryMock(null);
      model.findOne.mockReturnValue(query);
      const repository = createRepository(model);

      await repository.resolveActive('tenant-001', 'actor-001');

      expect(model.findOne).toHaveBeenCalledWith({
        tenantId: 'tenant-001',
        actorId: 'actor-001',
        status: 'active',
      });
    });

    it('必须使用最小投影且走 lean，不返回 Mongoose 文档', async () => {
      const model = createModelMock();
      const query = createQueryMock(null);
      model.findOne.mockReturnValue(query);
      const repository = createRepository(model);

      await repository.resolveActive('tenant-001', 'actor-001');

      expect(query.select).toHaveBeenCalledWith(
        'tenantId actorId employeeId status roleCodes scopes departmentIds version -_id',
      );
      expect(query.lean).toHaveBeenCalled();
    });

    it('找不到 active 快照时返回 null', async () => {
      const model = createModelMock();
      model.findOne.mockReturnValue(createQueryMock(null));
      const repository = createRepository(model);

      const result = await repository.resolveActive('tenant-404', 'actor-404');

      expect(result).toBeNull();
    });

    it('命中时返回不可变普通对象，数组为独立副本且已冻结', async () => {
      const model = createModelMock();
      const doc = createDoc();
      model.findOne.mockReturnValue(createQueryMock(doc));
      const repository = createRepository(model);

      const result = await repository.resolveActive('tenant-001', 'actor-001');

      expect(result).not.toBeNull();
      // 普通对象：与源文档不是同一引用。
      expect(result).not.toBe(doc);
      // 顶层冻结。
      expect(Object.isFrozen(result)).toBe(true);
      // 数组已冻结且为独立副本：修改返回值不影响源文档，反向亦然。
      expect(Object.isFrozen(result!.roleCodes)).toBe(true);
      expect(Object.isFrozen(result!.scopes)).toBe(true);
      expect(Object.isFrozen(result!.departmentIds)).toBe(true);
      expect(result!.roleCodes).not.toBe(doc.roleCodes);
      expect(result!.scopes).not.toBe(doc.scopes);
      expect(result!.departmentIds).not.toBe(doc.departmentIds);
      expect(() => (result!.roleCodes as string[]).push('hacker')).toThrow();
      expect(doc.roleCodes).toEqual(['admin']);
      // 字段内容完整。
      expect(result).toMatchObject({
        tenantId: 'tenant-001',
        actorId: 'actor-001',
        employeeId: 'employee-001',
        status: 'active',
        roleCodes: ['admin'],
        scopes: ['order:read'],
        departmentIds: ['dept-001'],
        version: 3,
      });
    });
  });

  describe('disable', () => {
    it('过滤条件强制包含 tenantId、actorId、active 状态与 expectedVersion，命中后 version +1', async () => {
      const model = createModelMock();
      model.updateOne.mockResolvedValue({ modifiedCount: 1 });
      const repository = createRepository(model);

      const ok = await repository.disable('tenant-001', 'actor-001', 3);

      expect(model.updateOne).toHaveBeenCalledWith(
        { tenantId: 'tenant-001', actorId: 'actor-001', status: 'active', version: 3 },
        { $set: { status: 'disabled' }, $inc: { version: 1 } },
      );
      expect(ok).toBe(true);
    });

    it('跨租户或未命中时不产生修改，返回 false', async () => {
      const model = createModelMock();
      model.updateOne.mockResolvedValue({ modifiedCount: 0 });
      const repository = createRepository(model);

      const ok = await repository.disable('tenant-999', 'actor-001', 3);

      expect(model.updateOne).toHaveBeenCalledWith(
        { tenantId: 'tenant-999', actorId: 'actor-001', status: 'active', version: 3 },
        { $set: { status: 'disabled' }, $inc: { version: 1 } },
      );
      expect(ok).toBe(false);
    });

    it('版本冲突（expectedVersion 不一致）时返回 false', async () => {
      const model = createModelMock();
      model.updateOne.mockResolvedValue({ modifiedCount: 0 });
      const repository = createRepository(model);

      const ok = await repository.disable('tenant-001', 'actor-001', 2);

      expect(model.updateOne).toHaveBeenCalledWith(
        { tenantId: 'tenant-001', actorId: 'actor-001', status: 'active', version: 2 },
        { $set: { status: 'disabled' }, $inc: { version: 1 } },
      );
      expect(ok).toBe(false);
    });
  });

  it('离职反查使用固定租户/员工投影并透传事务', async () => {
    const model = createModelMock();
    const exec = vi.fn().mockResolvedValue({ actorId: 'actor-001' });
    const lean = vi.fn().mockReturnValue({ exec });
    const session = vi.fn().mockReturnValue({ lean });
    const select = vi.fn().mockReturnValue({ session });
    model.findOne.mockReturnValue({ select });
    const mongoSession = {} as ClientSession;
    await expect(createRepository(model).findActorIdByEmployee(
      'tenant-001', 'employee-001', mongoSession,
    )).resolves.toBe('actor-001');
    expect(model.findOne).toHaveBeenCalledWith({ tenantId: 'tenant-001', employeeId: 'employee-001' });
    expect(select).toHaveBeenCalledWith('actorId -_id');
    expect(session).toHaveBeenCalledWith(mongoSession);
  });

  it('离职仅停用员工 active 快照、推进版本并返回命中状态', async () => {
    const model = createModelMock();
    model.updateOne.mockResolvedValue({ modifiedCount: 1 });
    const mongoSession = {} as ClientSession;
    await expect(createRepository(model).disableByEmployee(
      'tenant-001', 'employee-001', mongoSession,
    )).resolves.toBe(true);
    expect(model.updateOne).toHaveBeenCalledWith(
      { tenantId: 'tenant-001', employeeId: 'employee-001', status: 'active' },
      { $set: { status: 'disabled' }, $inc: { version: 1 } },
      { session: mongoSession },
    );
  });

  it('离职授权原语拒绝操作符形态标识且不访问数据库', async () => {
    const model = createModelMock();
    await expect(createRepository(model).disableByEmployee(
      'tenant-001', '$ne', {} as ClientSession,
    )).rejects.toThrow('标识非法');
    expect(model.updateOne).not.toHaveBeenCalled();
  });
});
