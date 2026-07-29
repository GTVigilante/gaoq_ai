import { describe, expect, it } from 'vitest';

import {
  buildDepartmentCreateInput,
  buildEmployeeCreateInput,
  canExecuteOrgWrite,
  canWriteOrgMaster,
  parseDepartmentResult,
  parseEmployeeResult,
  parseOrgChart,
} from '../../lib/org-contract.js';

const DEPARTMENT_ID = '01K00000000000000000000000';
const EMPLOYEE_ID = '01K00000000000000000000001';

const chart = {
  departments: [{
    id: DEPARTMENT_ID,
    code: 'FIN',
    name: '财务部',
    status: 'active',
    parentId: null,
    managerId: null,
    sortOrder: 0,
    version: 2,
  }],
  employees: [{
    id: EMPLOYEE_ID,
    employeeNo: 'E001',
    displayName: '员工甲',
    status: 'active',
    departmentIds: [DEPARTMENT_ID],
    primaryDepartmentId: DEPARTMENT_ID,
    positionIds: [],
    jobLevelId: null,
    version: 3,
  }],
};

describe('组织浏览器契约', () => {
  it('组织写入口只接受精确主数据写 Scope', () => {
    expect(canWriteOrgMaster(['erp:org:chart:read', 'erp:org:master:write'])).toBe(true);
    expect(canWriteOrgMaster(['erp:org:chart:read'])).toBe(false);
    expect(canWriteOrgMaster(['erp:org:master:read'])).toBe(false);
  });

  it('原请求重试要求同一可信主体仍持有写 Scope', () => {
    const profile = { actorId: 'manager-001', scopes: ['erp:org:master:write'] };
    expect(canExecuteOrgWrite(profile, 'manager-001')).toBe(true);
    expect(canExecuteOrgWrite(profile, 'manager-002')).toBe(false);
    expect(canExecuteOrgWrite({ ...profile, scopes: ['erp:org:chart:read'] }, 'manager-001')).toBe(false);
    expect(canExecuteOrgWrite(null, 'manager-001')).toBe(false);
  });

  it('接受最小公开投影并深度冻结数组', () => {
    const result = parseOrgChart(chart);

    expect(result).toEqual(chart);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.departments)).toBe(true);
    expect(Object.isFrozen(result.departments[0])).toBe(true);
    expect(Object.isFrozen(result.employees[0]?.departmentIds)).toBe(true);
  });

  it.each(['tenantId', 'createdAt', 'updatedAt'])('拒绝部门中的内部字段 %s', (field) => {
    const unsafe = {
      ...chart,
      departments: [{ ...chart.departments[0], [field]: 'internal-value' }],
    };

    expect(() => parseOrgChart(unsafe)).toThrow('ORG_DEPARTMENT_INVALID');
  });

  it('写入结果同样拒绝内部字段和未知包装字段', () => {
    expect(() => parseDepartmentResult({
      department: { ...chart.departments[0], tenantId: 'tenant-001' },
    })).toThrow('ORG_DEPARTMENT_INVALID');
    expect(() => parseEmployeeResult({
      employee: chart.employees[0],
      trace: 'internal',
    })).toThrow('ORG_EMPLOYEE_RESULT_INVALID');
  });

  it('拒绝顶层未知字段、重复聚合及不一致主部门', () => {
    expect(() => parseOrgChart({ ...chart, tenantId: 'tenant-001' })).toThrow('ORG_CHART_INVALID');
    expect(() => parseOrgChart({
      ...chart,
      departments: [chart.departments[0], chart.departments[0]],
    })).toThrow('ORG_CHART_INVALID');
    expect(() => parseOrgChart({
      ...chart,
      employees: [{
        ...chart.employees[0],
        primaryDepartmentId: '01K00000000000000000000002',
      }],
    })).toThrow('ORG_EMPLOYEE_INVALID');
  });

  it('部门创建载荷只保留白名单并规范空父部门', () => {
    expect(buildDepartmentCreateInput({
      code: 'FIN',
      name: ' 财务部 ',
      parentId: '',
      sortOrder: 1,
      tenantId: 'tenant-attacker',
      status: 'inactive',
    })).toEqual({
      code: 'FIN',
      name: '财务部',
      status: 'active',
      parentId: null,
      sortOrder: 1,
    });
  });

  it('员工创建载荷只保留白名单并从主部门生成受控数组', () => {
    expect(buildEmployeeCreateInput({
      employeeNo: 'E001',
      displayName: ' 员工甲 ',
      primaryDepartmentId: DEPARTMENT_ID,
      status: 'probation',
      departmentIds: ['01K00000000000000000000002'],
      positionIds: ['01K00000000000000000000003'],
      tenantId: 'tenant-attacker',
    })).toEqual({
      employeeNo: 'E001',
      displayName: '员工甲',
      status: 'probation',
      departmentIds: [DEPARTMENT_ID],
      primaryDepartmentId: DEPARTMENT_ID,
      positionIds: [],
    });
  });

  it('创建载荷拒绝非法编码、状态和部门标识', () => {
    expect(() => buildDepartmentCreateInput({ code: '$FIN', name: '财务部' }))
      .toThrow('ORG_DEPARTMENT_INPUT_INVALID');
    expect(() => buildEmployeeCreateInput({
      employeeNo: 'E001',
      displayName: '员工甲',
      primaryDepartmentId: 'department-001',
      status: 'terminated',
    })).toThrow('ORG_EMPLOYEE_INPUT_INVALID');
  });
});
