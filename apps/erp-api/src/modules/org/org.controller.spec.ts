import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { REQUIRED_SCOPES_KEY } from '../identity/auth.decorators.js';
import type { OrgApplicationService } from './application/org-application.service.js';
import { OrgController } from './org.controller.js';

const ID = '01K00000000000000000000000';
const VERSION = 2;
const NOW = '2026-07-29T00:00:00.000Z';

const department = Object.freeze({
  id: ID, tenantId: 'tenant-001', code: 'D001', name: '总部', status: 'active' as const,
  parentId: null, managerId: null, sortOrder: 0, version: VERSION, createdAt: NOW, updatedAt: NOW,
});
const departmentView = Object.freeze({
  id: ID, code: 'D001', name: '总部', status: 'active' as const,
  parentId: null, managerId: null, sortOrder: 0, version: VERSION,
});
const position = Object.freeze({
  id: ID, tenantId: 'tenant-001', code: 'P001', name: '架构师', status: 'active' as const,
  version: VERSION, createdAt: NOW, updatedAt: NOW,
});
const positionView = Object.freeze({
  id: ID, code: 'P001', name: '架构师', status: 'active' as const, version: VERSION,
});
const jobLevel = Object.freeze({
  id: ID, tenantId: 'tenant-001', code: 'M1', name: '一级经理',
  track: 'management' as const, rank: 1, version: VERSION, createdAt: NOW, updatedAt: NOW,
});
const jobLevelView = Object.freeze({
  id: ID, code: 'M1', name: '一级经理', track: 'management' as const, rank: 1, version: VERSION,
});
const employee = Object.freeze({
  id: ID, tenantId: 'tenant-001', employeeNo: 'E001', displayName: '员工甲',
  status: 'active' as const, departmentIds: [ID], primaryDepartmentId: ID,
  positionIds: [], jobLevelId: null, version: VERSION, createdAt: NOW, updatedAt: NOW,
});
const employeeView = Object.freeze({
  id: ID, employeeNo: 'E001', displayName: '员工甲', status: 'active' as const,
  departmentIds: [ID], primaryDepartmentId: ID, positionIds: [], jobLevelId: null, version: VERSION,
});
const chart = Object.freeze({ departments: [department], employees: [employee] });
const chartView = Object.freeze({ departments: [departmentView], employees: [employeeView] });

function fixture() {
  const organization = {
    getOrgChart: vi.fn().mockResolvedValue(chart),
    createDepartment: vi.fn().mockResolvedValue({ department }),
    updateDepartment: vi.fn().mockResolvedValue({ department }),
    createPosition: vi.fn().mockResolvedValue({ position }),
    updatePosition: vi.fn().mockResolvedValue({ position }),
    createJobLevel: vi.fn().mockResolvedValue({ jobLevel }),
    updateJobLevel: vi.fn().mockResolvedValue({ jobLevel }),
    createEmployee: vi.fn().mockResolvedValue({ employee }),
    updateEmployee: vi.fn().mockResolvedValue({ employee }),
    transitionEmployeeStatus: vi.fn().mockResolvedValue({ employee }),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const response = { setHeader: vi.fn() };
  const controller = new OrgController(
    organization as unknown as OrgApplicationService,
    audit as unknown as AuditService,
  );
  return { controller, organization, audit, response };
}

describe('OrgController', () => {
  it.each([
    ['getChart', 'erp:org:chart:read'],
    ['createDepartment', 'erp:org:master:write'],
    ['updateDepartment', 'erp:org:master:write'],
    ['createPosition', 'erp:org:master:write'],
    ['updatePosition', 'erp:org:master:write'],
    ['createJobLevel', 'erp:org:master:write'],
    ['updateJobLevel', 'erp:org:master:write'],
    ['createEmployee', 'erp:org:master:write'],
    ['updateEmployee', 'erp:org:master:write'],
    ['transitionEmployeeStatus', 'erp:org:master:write'],
  ] as const)('%s 声明精确 Scope', (name, scope) => {
    expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, method(name))).toEqual([scope]);
  });

  it('组织图只调用权威组织应用服务', async () => {
    const store = fixture();
    const result = await store.controller.getChart();

    expect(result).toEqual(chartView);
    expectPublicProjection(result);
    expect(store.organization.getOrgChart).toHaveBeenCalledTimes(1);
    expect(store.audit.record).not.toHaveBeenCalled();
  });

  it('创建部门返回强 ETag 并写稳定审计', async () => {
    const store = fixture();
    const body = { code: 'D001', name: '总部' };

    await expect(store.controller.createDepartment(
      'org-department-create-001',
      body,
      store.response as never,
    )).resolves.toEqual({ department: departmentView });

    expect(store.organization.createDepartment).toHaveBeenCalledWith(
      'org-department-create-001',
      body,
    );
    expectSuccess(store, 'org.department.create', 'org_department');
  });

  it('创建岗位返回强 ETag 并写稳定审计', async () => {
    const store = fixture();
    const body = { code: 'P001', name: '架构师' };

    await expect(store.controller.createPosition(
      'org-position-create-001',
      body,
      store.response as never,
    )).resolves.toEqual({ position: positionView });

    expect(store.organization.createPosition).toHaveBeenCalledWith(
      'org-position-create-001',
      body,
    );
    expectSuccess(store, 'org.position.create', 'org_position');
  });

  it('创建职级返回强 ETag 并写稳定审计', async () => {
    const store = fixture();
    const body = { code: 'M1', name: '一级经理', track: 'management' as const, rank: 1 };

    await expect(store.controller.createJobLevel(
      'org-job-level-create-001',
      body,
      store.response as never,
    )).resolves.toEqual({ jobLevel: jobLevelView });

    expect(store.organization.createJobLevel).toHaveBeenCalledWith(
      'org-job-level-create-001',
      body,
    );
    expectSuccess(store, 'org.job_level.create', 'org_job_level');
  });

  it('创建员工返回强 ETag 并写稳定审计', async () => {
    const store = fixture();
    const body = {
      employeeNo: 'E001',
      displayName: '员工甲',
      departmentIds: [ID],
      primaryDepartmentId: ID,
    };

    await expect(store.controller.createEmployee(
      'org-employee-create-001',
      body,
      store.response as never,
    )).resolves.toEqual({ employee: employeeView });

    expect(store.organization.createEmployee).toHaveBeenCalledWith(
      'org-employee-create-001',
      body,
    );
    expectSuccess(store, 'org.employee.create', 'org_employee');
  });

  it('更新部门校验资源版本并写稳定审计', async () => {
    const store = fixture();
    const body = { name: '新总部' };

    await expect(store.controller.updateDepartment(
      ID,
      '"1"',
      'org-department-update-001',
      body,
      store.response as never,
    )).resolves.toEqual({ department: departmentView });

    expect(store.organization.updateDepartment).toHaveBeenCalledWith(
      ID,
      1,
      'org-department-update-001',
      body,
    );
    expectSuccess(store, 'org.department.update', 'org_department');
  });

  it('更新岗位校验资源版本并写稳定审计', async () => {
    const store = fixture();
    const body = { name: '高级架构师' };

    await expect(store.controller.updatePosition(
      ID,
      '"1"',
      'org-position-update-001',
      body,
      store.response as never,
    )).resolves.toEqual({ position: positionView });

    expect(store.organization.updatePosition).toHaveBeenCalledWith(
      ID,
      1,
      'org-position-update-001',
      body,
    );
    expectSuccess(store, 'org.position.update', 'org_position');
  });

  it('更新职级校验资源版本并写稳定审计', async () => {
    const store = fixture();
    const body = { rank: 2 };

    await expect(store.controller.updateJobLevel(
      ID,
      '"1"',
      'org-job-level-update-001',
      body,
      store.response as never,
    )).resolves.toEqual({ jobLevel: jobLevelView });

    expect(store.organization.updateJobLevel).toHaveBeenCalledWith(
      ID,
      1,
      'org-job-level-update-001',
      body,
    );
    expectSuccess(store, 'org.job_level.update', 'org_job_level');
  });

  it('更新员工校验资源版本并写稳定审计', async () => {
    const store = fixture();
    const body = { displayName: '员工乙' };

    await expect(store.controller.updateEmployee(
      ID,
      '"1"',
      'org-employee-update-001',
      body,
      store.response as never,
    )).resolves.toEqual({ employee: employeeView });

    expect(store.organization.updateEmployee).toHaveBeenCalledWith(
      ID,
      1,
      'org-employee-update-001',
      body,
    );
    expectSuccess(store, 'org.employee.update', 'org_employee');
  });

  it('员工状态转换返回员工投影并写 R1 审计', async () => {
    const store = fixture();
    const body = { status: 'suspended' as const };

    await expect(store.controller.transitionEmployeeStatus(
      ID,
      '"1"',
      'org-employee-status-001',
      body,
      store.response as never,
    )).resolves.toEqual({ employee: employeeView });

    expect(store.organization.transitionEmployeeStatus).toHaveBeenCalledWith(
      ID,
      1,
      'org-employee-status-001',
      body,
    );
    expectSuccess(store, 'org.employee.status_transition', 'org_employee');
  });

  it('REST 在进入组织应用服务前拒绝绕过 Care 直接离职', async () => {
    const store = fixture();

    await expect(store.controller.transitionEmployeeStatus(
      ID,
      '"1"',
      'terminate-key-001',
      { status: 'terminated' },
      store.response as never,
    )).rejects.toMatchObject({
      response: { code: 'ORG_CARE_WORKFLOW_REQUIRED' },
    });

    expect(store.organization.transitionEmployeeStatus).not.toHaveBeenCalled();
    expect(store.audit.record).not.toHaveBeenCalled();
  });

  it.each([
    [undefined],
    [''],
  ] as const)('写接口拒绝缺失幂等键：%s', async (key) => {
    const store = fixture();

    await expect(store.controller.createDepartment(
      key,
      { code: 'D001', name: '总部' },
      store.response as never,
    )).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });

    expect(store.organization.createDepartment).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, 'ORG_IF_MATCH_REQUIRED'],
    ['', 'ORG_IF_MATCH_REQUIRED'],
    ['1', 'ORG_IF_MATCH_REQUIRED'],
    ['W/"1"', 'ORG_IF_MATCH_REQUIRED'],
    ['"9007199254740992"', 'ORG_INVALID_VERSION'],
  ] as const)('更新接口拒绝非法 If-Match：%s', async (ifMatch, code) => {
    const store = fixture();

    await expect(store.controller.updateDepartment(
      ID,
      ifMatch,
      'org-department-version-invalid',
      { name: '新总部' },
      store.response as never,
    )).rejects.toMatchObject({ response: { code } });

    expect(store.organization.updateDepartment).not.toHaveBeenCalled();
  });

  it('更新接口拒绝非 ULID 资源标识', async () => {
    const store = fixture();

    await expect(store.controller.updateDepartment(
      'department-001',
      '"1"',
      'org-department-id-invalid',
      { name: '新总部' },
      store.response as never,
    )).rejects.toMatchObject({ response: { code: 'ORG_INVALID_ID' } });

    expect(store.organization.updateDepartment).not.toHaveBeenCalled();
  });

  it('业务提交后的审计故障只告警，不反向暴露为失败', async () => {
    const store = fixture();
    store.audit.record.mockRejectedValue(new Error('audit unavailable'));
    const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const result = await store.controller.createEmployee(
      'org-employee-audit-failed',
      {
        employeeNo: 'E001',
        displayName: '员工甲',
        departmentIds: [ID],
        primaryDepartmentId: ID,
      },
      store.response as never,
    );

    expect(result).toEqual({ employee: employeeView });
    expect(store.organization.createEmployee).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith({
      code: 'ORG_AUDIT_AFTER_COMMIT_FAILED',
      action: 'org.employee.create',
      resourceType: 'org_employee',
      resourceId: ID,
    });
  });

  it('组织业务失败时保留原始异常且不伪造成功审计', async () => {
    const store = fixture();
    const failure = new Error('organization storage unavailable');
    store.organization.updateEmployee.mockRejectedValue(failure);

    await expect(store.controller.updateEmployee(
      ID,
      '"1"',
      'org-employee-update-failed',
      { displayName: '员工乙' },
      store.response as never,
    )).rejects.toBe(failure);

    expect(store.audit.record).not.toHaveBeenCalled();
    expect(store.response.setHeader).not.toHaveBeenCalled();
  });
});

function expectSuccess(
  store: ReturnType<typeof fixture>,
  action: string,
  resourceType: string,
): void {
  expect(store.response.setHeader).toHaveBeenCalledWith('ETag', `"${VERSION}"`);
  expect(store.audit.record).toHaveBeenCalledWith({
    action,
    resourceType,
    resourceId: ID,
    riskLevel: 'R1',
    outcome: 'success',
  });
}

function expectPublicProjection(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain('tenantId');
  expect(serialized).not.toContain('createdAt');
  expect(serialized).not.toContain('updatedAt');
}

function method(
  name:
  | 'getChart'
  | 'createDepartment'
  | 'updateDepartment'
  | 'createPosition'
  | 'updatePosition'
  | 'createJobLevel'
  | 'updateJobLevel'
  | 'createEmployee'
  | 'updateEmployee'
  | 'transitionEmployeeStatus',
): object {
  return Object.getOwnPropertyDescriptor(OrgController.prototype, name)?.value as object;
}
