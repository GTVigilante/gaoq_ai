import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { REQUIRED_SCOPES_KEY } from '../identity/auth.decorators.js';
import type { CreateSupplierDraftDto } from './application/supplier.dto.js';
import type { SupplierService } from './application/supplier.service.js';
import { SupplierController } from './supplier.controller.js';

const SUPPLIER_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y9';
const input: CreateSupplierDraftDto = {
  partyKind: 'individual', legalForm: 'individual', displayName: '林一工作室',
  legalIdentity: { identifierType: 'national_id', identifier: '110101199001011234', legalName: '林一' },
  ownerEmployeeId: 'employee-1', responsibleDepartmentId: 'department-1', riskTier: 'medium',
  capabilities: [{ serviceCategoryCode: 'video_editing', level: 'verified' }], rates: [],
};
const supplier = { id: SUPPLIER_ID, version: 2, status: 'under_review' };

function fixture() {
  const suppliers = {
    createDraft: vi.fn().mockResolvedValue({ supplier: { ...supplier, version: 1, status: 'draft' } }),
    search: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    get: vi.fn().mockResolvedValue(supplier),
    updateDraft: vi.fn().mockResolvedValue({ supplier }), replaceCapabilities: vi.fn().mockResolvedValue({ supplier }),
    replaceRates: vi.fn().mockResolvedValue({ supplier }), submit: vi.fn().mockResolvedValue({ supplier }),
    decide: vi.fn().mockResolvedValue({ supplier }), suspend: vi.fn().mockResolvedValue({ supplier }),
    reactivate: vi.fn().mockResolvedValue({ supplier }), close: vi.fn().mockResolvedValue({ supplier }),
    resolveEligibility: vi.fn().mockResolvedValue({ supplierId: SUPPLIER_ID, eligible: true }),
  };
  const record = vi.fn().mockResolvedValue(undefined); const headers = new Map<string, string>();
  const response = { setHeader: vi.fn((name: string, value: string) => headers.set(name, value)) } as unknown as Response;
  const controller = new SupplierController(suppliers as unknown as SupplierService, { record } as unknown as AuditService);
  const errorLog = vi.spyOn((controller as unknown as { logger: { error: (value: unknown) => void } }).logger, 'error').mockImplementation(() => undefined);
  return { controller, suppliers, record, response, headers, errorLog };
}

describe('SupplierController', () => {
  it('十二个端点声明最小供应方 Scope', () => {
    const expected = {
      create: 'erp:supplier:relationship:write', search: 'erp:supplier:relationship:read',
      get: 'erp:supplier:relationship:read', update: 'erp:supplier:relationship:write',
      replaceCapabilities: 'erp:supplier:catalog:write', replaceRates: 'erp:supplier:catalog:write',
      submit: 'erp:supplier:relationship:write', decide: 'erp:supplier:relationship:decide',
      statusSuspend: 'erp:supplier:relationship:decide', statusReactivate: 'erp:supplier:relationship:decide',
      statusClose: 'erp:supplier:relationship:decide', eligibility: 'erp:supplier:eligibility:read',
    } as const;
    for (const [name, scope] of Object.entries(expected)) {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- 这里只读取装饰器元数据，不调用方法。
      const handler = SupplierController.prototype[name as keyof typeof expected];
      expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, handler)).toEqual([scope]);
    }
  });

  it('创建成功返回强 ETag，并只写低敏提交后审计', async () => {
    const value = fixture();
    const result = await value.controller.create('supplier-create-001', input, value.response);
    expect(result.supplier).toMatchObject({ status: 'draft', version: 1 });
    expect(value.headers.get('ETag')).toBe('"1"');
    expect(value.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success', resourceId: SUPPLIER_ID, metadata: { version: 1, status: 'draft' } }));
    expect(JSON.stringify(value.record.mock.calls)).not.toContain(input.legalIdentity.identifier);
  });

  it('业务失败写失败审计，审计故障不覆盖原始异常', async () => {
    const value = fixture(); const businessFailure = new Error('business-failure');
    value.suppliers.submit.mockRejectedValueOnce(businessFailure); value.record.mockRejectedValueOnce(new Error('audit-failure'));
    await expect(value.controller.submit(SUPPLIER_ID, '"1"', 'supplier-submit-001', {}, value.response)).rejects.toBe(businessFailure);
    expect(value.errorLog).toHaveBeenCalledWith(expect.objectContaining({ code: 'SUPPLIER_FAILURE_AUDIT_WRITE_FAILED' }));
  });

  it('提交后成功审计故障不改变业务响应', async () => {
    const value = fixture(); value.record.mockRejectedValueOnce(new Error('audit-failure'));
    await expect(value.controller.submit(SUPPLIER_ID, '"1"', 'supplier-submit-001', {}, value.response)).resolves.toEqual({ supplier });
    expect(value.errorLog).toHaveBeenCalledWith(expect.objectContaining({ code: 'SUPPLIER_COMMITTED_AUDIT_WRITE_FAILED' }));
  });

  it('拒绝非规范资源、弱版本、短幂等键和非空动作正文', async () => {
    const value = fixture();
    await expect(value.controller.submit('bad', '"1"', 'supplier-submit-001', {}, value.response)).rejects.toMatchObject({ response: { code: 'SUPPLIER_ID_INVALID' } });
    await expect(value.controller.submit(SUPPLIER_ID, '1', 'supplier-submit-001', {}, value.response)).rejects.toMatchObject({ response: { code: 'SUPPLIER_IF_MATCH_REQUIRED' } });
    await expect(value.controller.submit(SUPPLIER_ID, '"1"', 'short', {}, value.response)).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });
    await expect(value.controller.submit(SUPPLIER_ID, '"1"', 'supplier-submit-001', { unexpected: true }, value.response)).rejects.toMatchObject({ response: { code: 'SUPPLIER_BODY_FORBIDDEN' } });
  });
});
