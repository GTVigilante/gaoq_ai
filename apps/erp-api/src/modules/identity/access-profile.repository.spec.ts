import type { ClientSession, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { AccessProfileRepository } from './access-profile.repository.js';
import type { AccessProfileDocument } from './access-profile.schema.js';

/** 构造 mock Model：findOne 返回 select/lean/exec 链，updateOne 直接返回结果。 */
const createModelMock = () => ({
  findOne: vi.fn(),
  find: vi.fn(),
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
  scopes: ['erp:order:sales_order:read'],
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

    it('查询前拒绝操作符形态租户或主体且不访问数据库', async () => {
      const model = createModelMock();
      const repository = createRepository(model);

      await expect(repository.resolveActive('$where', 'actor-001')).rejects.toThrow('标识非法');
      await expect(repository.resolveActive('tenant-001', '$ne')).rejects.toThrow('标识非法');
      expect(model.findOne).not.toHaveBeenCalled();
    });

    it('透传可选事务，并拒绝跨租户或受损授权快照', async () => {
      const model = createModelMock();
      const doc = createDoc();
      const exec = vi.fn().mockResolvedValue({ ...doc, tenantId: 'tenant-attacker' });
      const lean = vi.fn().mockReturnValue({ exec });
      const selected = { lean };
      const query = { select: vi.fn().mockReturnValue(selected), session: vi.fn() };
      query.session.mockReturnValue(query);
      model.findOne.mockReturnValue(query);

      await expect(createRepository(model).resolveActive(
        'tenant-001', 'actor-001', {} as ClientSession,
      )).rejects.toThrow('持久化记录受损');
      expect(query.session).toHaveBeenCalledOnce();
    });

    it.each([
      { field: 'actorId', value: '$bad' },
      { field: 'status', value: 'disabled' },
      { field: 'roleCodes', value: ['admin', 'admin'] },
      { field: 'scopes', value: ['invalid'] },
      { field: 'departmentIds', value: ['$bad'] },
      { field: 'version', value: 0 },
    ])('拒绝受损字段 $field', async ({ field, value }) => {
      const model = createModelMock();
      model.findOne.mockReturnValue(createQueryMock({ ...createDoc(), [field]: value }));
      await expect(createRepository(model).resolveActive(
        'tenant-001', 'actor-001',
      )).rejects.toThrow('持久化记录受损');
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
        scopes: ['erp:order:sales_order:read'],
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

    it.each([
      ['tenant-001', '$ne', 1],
      ['$where', 'actor-001', 1],
      ['tenant-001', 'actor-001', 0],
      ['tenant-001', 'actor-001', 1.5],
      ['tenant-001', 'actor-001', 1_000_000_001],
    ])('拒绝非法停用条件且不写库', async (tenantId, actorId, version) => {
      const model = createModelMock();
      await expect(createRepository(model).disable(tenantId, actorId, version)).rejects.toThrow();
      expect(model.updateOne).not.toHaveBeenCalled();
    });
  });

  describe('findActiveByRoles', () => {
    const createListQuery = (records: unknown[]) => {
      const exec = vi.fn().mockResolvedValue(records);
      const lean = vi.fn().mockReturnValue({ exec });
      const select = vi.fn().mockReturnValue({ lean });
      const limited = { select, session: vi.fn() };
      limited.session.mockReturnValue(limited);
      const limit = vi.fn().mockReturnValue(limited);
      const sort = vi.fn().mockReturnValue({ limit });
      return { sort, limit, limited };
    };

    it('按固定角色与部门交集查询、透传事务并冻结结果', async () => {
      const model = createModelMock();
      const chain = createListQuery([createDoc()]);
      model.find.mockReturnValue({ sort: chain.sort });
      const session = {} as ClientSession;
      const result = await createRepository(model).findActiveByRoles(
        'tenant-001', ['approver'], ['dept-001'], session,
      );
      expect(model.find).toHaveBeenCalledWith({
        tenantId: 'tenant-001',
        status: 'active',
        roleCodes: { $in: ['approver'] },
        departmentIds: { $in: ['dept-001'] },
      });
      expect(chain.sort).toHaveBeenCalledWith({ actorId: 1 });
      expect(chain.limited.session).toHaveBeenCalledWith(session);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result[0])).toBe(true);
    });

    it('允许不限制部门，并拒绝重复或非法查询参数', async () => {
      const model = createModelMock();
      const chain = createListQuery([]);
      model.find.mockReturnValue({ sort: chain.sort });
      const repository = createRepository(model);
      await repository.findActiveByRoles('tenant-001', ['approver'], null);
      expect(model.find).toHaveBeenCalledWith({
        tenantId: 'tenant-001', status: 'active', roleCodes: { $in: ['approver'] },
      });

      for (const [roles, departments] of [
        [[], null],
        [['a', 'a'], null],
        [['$bad'], null],
        [['a'], []],
        [['a'], ['dept-001', 'dept-001']],
        [['a'], ['$bad']],
      ] as const) {
        await expect(repository.findActiveByRoles(
          'tenant-001', roles, departments,
        )).rejects.toThrow('参数非法');
      }
    });

    it('拒绝超过 500 人以及跨租户持久化结果', async () => {
      const model = createModelMock();
      let chain = createListQuery(Array.from({ length: 501 }, createDoc));
      model.find.mockReturnValueOnce({ sort: chain.sort });
      const repository = createRepository(model);
      await expect(repository.findActiveByRoles(
        'tenant-001', ['approver'], null,
      )).rejects.toThrow('超过 500');

      chain = createListQuery([{ ...createDoc(), tenantId: 'tenant-attacker' }]);
      model.find.mockReturnValueOnce({ sort: chain.sort });
      await expect(repository.findActiveByRoles(
        'tenant-001', ['approver'], null,
      )).rejects.toThrow('持久化记录受损');
    });
  });

  it('离职反查使用固定租户/员工投影并透传事务', async () => {
    const model = createModelMock();
    const exec = vi.fn().mockResolvedValue({ actorId: 'actor-001' });
    const lean = vi.fn().mockReturnValue({ exec });
    const selectedQuery = { lean, session: vi.fn() };
    selectedQuery.session.mockReturnValue(selectedQuery);
    const select = vi.fn().mockReturnValue(selectedQuery);
    model.findOne.mockReturnValue({ select });
    const mongoSession = {} as ClientSession;
    await expect(createRepository(model).findActorIdByEmployee(
      'tenant-001', 'employee-001', mongoSession,
    )).resolves.toBe('actor-001');
    expect(model.findOne).toHaveBeenCalledWith({ tenantId: 'tenant-001', employeeId: 'employee-001' });
    expect(select).toHaveBeenCalledWith('actorId -_id');
    expect(selectedQuery.session).toHaveBeenCalledWith(mongoSession);
  });

  it('员工反查未命中返回 null，受损主体失败关闭', async () => {
    const model = createModelMock();
    model.findOne
      .mockReturnValueOnce(createQueryMock(null))
      .mockReturnValueOnce(createQueryMock({ actorId: '$bad' }));
    const repository = createRepository(model);
    await expect(repository.findActorIdByEmployee(
      'tenant-001', 'employee-001',
    )).resolves.toBeNull();
    await expect(repository.findActorIdByEmployee(
      'tenant-001', 'employee-001',
    )).rejects.toThrow('标识非法');
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

  it('开户前只投影员工主体与启停状态', async () => {
    const model = createModelMock();
    const query = createQueryMock({ actorId: 'actor-001', status: 'active' });
    model.findOne.mockReturnValue(query);
    const result = await createRepository(model).resolveEmployeeIdentity(
      'tenant-001', 'employee-001',
    );
    expect(model.findOne).toHaveBeenCalledWith({ tenantId: 'tenant-001', employeeId: 'employee-001' });
    expect(query.select).toHaveBeenCalledWith('actorId status -_id');
    expect(result).toEqual({ actorId: 'actor-001', status: 'active' });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('开户前未命中返回 null，受损状态失败关闭', async () => {
    const model = createModelMock();
    model.findOne
      .mockReturnValueOnce(createQueryMock(null))
      .mockReturnValueOnce(createQueryMock({ actorId: 'actor-001', status: 'corrupt' }));
    const repository = createRepository(model);
    await expect(repository.resolveEmployeeIdentity(
      'tenant-001', 'employee-001',
    )).resolves.toBeNull();
    await expect(repository.resolveEmployeeIdentity(
      'tenant-001', 'employee-001',
    )).rejects.toThrow('持久化记录受损');
  });

  it('开户事务幂等创建零权限 active 主体且不覆盖既有快照', async () => {
    const model = createModelMock();
    model.updateOne.mockResolvedValue({ modifiedCount: 0 });
    const session = {} as ClientSession;
    await createRepository(model).ensureProvisionedEmployee(
      'tenant-001',
      'employee-001',
      'actor-001',
      ['department-001', 'department-001'],
      session,
    );
    expect(model.updateOne).toHaveBeenCalledWith(
      { tenantId: 'tenant-001', employeeId: 'employee-001', actorId: 'actor-001', status: 'active' },
      {
        $setOnInsert: {
          tenantId: 'tenant-001', employeeId: 'employee-001', actorId: 'actor-001',
          status: 'active', roleCodes: [], scopes: [], departmentIds: ['department-001'], version: 1,
        },
      },
      { upsert: true, session, runValidators: true },
    );
  });

  it('开户拒绝非法主体、空部门或过量部门且不写库', async () => {
    const model = createModelMock();
    const repository = createRepository(model);
    for (const [actorId, departmentIds] of [
      ['$bad', ['dept-001']],
      ['actor-001', []],
      ['actor-001', ['$bad']],
      ['actor-001', Array.from({ length: 501 }, (_, index) => `dept-${index}`)],
    ] as const) {
      await expect(repository.ensureProvisionedEmployee(
        'tenant-001', 'employee-001', actorId, departmentIds, {} as ClientSession,
      )).rejects.toThrow('参数非法');
    }
    expect(model.updateOne).not.toHaveBeenCalled();
  });
});
