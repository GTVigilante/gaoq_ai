import { createHash, createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OpOrgHttpRequest } from './op-org-http.client.js';
import { OpOrgPushAdapter } from './op-org-push.adapter.js';
import type { OrgPlatformCredentialService } from './org-platform-credential.service.js';

const NOW = new Date('2026-07-22T08:00:00.000Z');
const SECRET = 'op-outbound-hmac-secret-at-least-32-characters';

function fixture(responseBody: unknown = { code: 'OK', data: { externalId: 'department-001' } }) {
  const credentials = { resolve: vi.fn().mockResolvedValue({
    clientId: 'erp-op-org-001', clientSecret: SECRET, externalTenantId: 'op-tenant-001',
  }) };
  const http = { request: vi.fn().mockResolvedValue({
    status: 200, requestId: 'request-001', body: responseBody,
  }) };
  const adapter = new OpOrgPushAdapter(
    credentials as unknown as OrgPlatformCredentialService,
    http,
  );
  return { adapter, credentials, http };
}

describe('OpOrgPushAdapter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => vi.useRealTimers());

  it('部门下发使用 ERP 标识、版本、幂等键与独立 HMAC 原始字节签名', async () => {
    const store = fixture();
    const result = await store.adapter.pushDepartment({
      tenantId: 'tenant-001', departmentId: 'department-001', version: 3,
      code: 'SALES', name: '销售部', status: 'active', parentExternalId: null,
      managerExternalId: 'employee-001', sortOrder: 10, currentExternalId: null,
      idempotencyKey: 'tenant-001:department-001:3',
    });
    expect(result).toEqual({ externalId: 'department-001', requestId: 'request-001' });
    expect(store.credentials.resolve).toHaveBeenCalledWith('tenant-001', 'op');
    const request = store.http.request.mock.calls[0]?.[0] as unknown as OpOrgHttpRequest;
    expect(request).toMatchObject({
      method: 'PUT', path: '/erp/v1/org/departments/department-001',
      headers: {
        'x-gaoq-erp-client-id': 'erp-op-org-001',
        'x-gaoq-erp-external-tenant-id': 'op-tenant-001',
        'x-gaoq-erp-idempotency-key': 'tenant-001:department-001:3',
        'x-gaoq-erp-signature-algorithm': 'hmac-sha256',
      },
    });
    const body = request.body ?? '';
    expect(JSON.parse(body)).toMatchObject({
      erpDepartmentId: 'department-001', version: 3, name: '销售部',
    });
    const timestamp = request.headers['x-gaoq-erp-timestamp'] ?? '';
    const nonce = request.headers['x-gaoq-erp-nonce'] ?? '';
    const canonical = [
      timestamp, nonce, 'PUT', request.path, 'op-tenant-001',
      'tenant-001:department-001:3',
      createHash('sha256').update(body).digest('base64url'),
    ].join('\n');
    expect(request.headers['x-gaoq-erp-signature']).toBe(
      createHmac('sha256', SECRET).update(canonical).digest('hex'),
    );
  });

  it('员工首次组织下发不要求联系方式，且私密开户通道永久拒绝 OP', async () => {
    const store = fixture({ code: 'OK', data: { externalId: 'employee-001' } });
    await expect(store.adapter.pushEmployee({
      tenantId: 'tenant-001', employeeId: 'employee-001', version: 1,
      employeeNo: 'E001', displayName: '测试员工', status: 'active',
      departmentExternalIds: ['department-001'],
      primaryDepartmentExternalId: 'department-001', currentExternalId: null,
      idempotencyKey: 'tenant-001:employee-001:1',
    })).resolves.toMatchObject({ externalId: 'employee-001' });
    await expect(store.adapter.provisionEmployee({
      tenantId: 'tenant-001', employeeId: 'employee-001', externalUserId: 'employee-001',
      employeeNo: 'E001', displayName: '测试员工', departmentExternalIds: ['department-001'],
      idempotencyKey: 'tenant-001:employee-001:provision', contact: {},
    })).rejects.toMatchObject({ code: 'OP_IDENTITY_BINDING_REQUIRED', category: 'business' });
  });

  it('快照严格投影为对账白名单，不保留未知正文', async () => {
    const store = fixture({ code: 'OK', data: {
      departments: [{
        externalId: 'department-001', name: '销售部', parentExternalId: null,
        status: 'active',
      }],
      employees: [{
        externalId: 'employee-001', employeeNo: 'E001', displayName: '测试员工',
        departmentExternalIds: ['department-001'], suspended: false, resigned: false,
      }],
    } });
    const snapshot = await store.adapter.fetchSnapshot('tenant-001');
    expect(snapshot.departments.get('department-001')).toEqual({
      name: '销售部', parentExternalId: null, status: 'active',
    });
    expect(snapshot.employees.get('employee-001')).toMatchObject({
      employeeNo: 'E001', departmentExternalIds: ['department-001'],
    });
  });
});
