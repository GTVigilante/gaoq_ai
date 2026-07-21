import type { ClientSession, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { Department } from '../domain/department.js';
import { DepartmentRepository, OrgWriteConflictError } from './org.repositories.js';
import type { OrgDepartmentDocument } from './org.schemas.js';

const mongoSession = {} as ClientSession;
const context = new TenantContextService();
const trustedContext = {
  tenant: { tenantId: 'tenant-001', source: 'access_token' as const },
  actor: {
    actorId: 'actor-001',
    actorType: 'user' as const,
    tenantId: 'tenant-001',
    roleCodes: ['org-admin'],
    scopes: ['org:read', 'org:write'],
    departmentIds: [],
    traceId: 'trace-001',
  },
};

const department: Department = {
  id: 'department-001',
  tenantId: 'tenant-001',
  code: 'HR',
  name: '人力资源部',
  status: 'active',
  parentId: null,
  managerId: null,
  sortOrder: 0,
  version: 2,
  createdAt: '2026-07-21T00:00:00.000Z',
  updatedAt: '2026-07-21T01:00:00.000Z',
};

const createFixture = () => {
  const exec = vi.fn();
  const session = vi.fn().mockReturnThis();
  const lean = vi.fn().mockReturnValue({ exec });
  const findOne = vi.fn().mockReturnValue({ session, lean });
  const create = vi.fn().mockResolvedValue([]);
  const updateOne = vi.fn();
  const model = { findOne, create, updateOne };
  return {
    repository: new DepartmentRepository(
      context,
      model as unknown as Model<OrgDepartmentDocument>,
    ),
    exec,
    session,
    findOne,
    create,
    updateOne,
  };
};

describe('DepartmentRepository', () => {
  it('查询租户只能来自可信上下文，调用方无法传入 tenantId', async () => {
    const fixture = createFixture();
    fixture.exec.mockResolvedValue(null);

    await context.run(trustedContext, () => fixture.repository.findById('department-001'));

    expect(fixture.findOne).toHaveBeenCalledWith({
      tenantId: 'tenant-001',
      id: 'department-001',
    });
  });

  it('插入跨租户实体时在访问 Model 前拒绝', async () => {
    const fixture = createFixture();

    await expect(
      context.run(trustedContext, () =>
        fixture.repository.insert({ ...department, tenantId: 'attacker-tenant' }, mongoSession),
      ),
    ).rejects.toThrow('拒绝跨租户实体');
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it('更新条件包含可信租户与 expectedVersion，且不修改 id/tenantId/createdAt', async () => {
    const fixture = createFixture();
    fixture.updateOne.mockResolvedValue({ matchedCount: 1 });

    await context.run(trustedContext, () =>
      fixture.repository.replace(department, 1, mongoSession),
    );

    const call = fixture.updateOne.mock.calls[0];
    expect(call?.[0]).toEqual({ tenantId: 'tenant-001', id: 'department-001', version: 1 });
    expect(call?.[1]).toMatchObject({ $set: { version: 2, name: '人力资源部' } });
    const update = call?.[1] as { readonly $set: Record<string, unknown> };
    expect(update.$set).not.toHaveProperty('tenantId');
    expect(update.$set).not.toHaveProperty('id');
    expect(update.$set).not.toHaveProperty('createdAt');
    expect(call?.[2]).toEqual({ session: mongoSession, timestamps: false });
  });

  it('乐观版本未命中时抛写冲突', async () => {
    const fixture = createFixture();
    fixture.updateOne.mockResolvedValue({ matchedCount: 0 });

    await expect(
      context.run(trustedContext, () => fixture.repository.replace(department, 1, mongoSession)),
    ).rejects.toBeInstanceOf(OrgWriteConflictError);
  });
});
