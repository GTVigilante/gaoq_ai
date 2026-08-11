import { describe, expect, it } from 'vitest';
import { awardSourcing, createSourcingDraft, publishSourcing, recordSourcingResponse, startSourcingEvaluation, submitSourcing } from './sourcing.js';

const NOW = new Date('2026-08-11T01:00:00.000Z'); const SUPPLIER = '01J8ZQK7V0A2M4N6P8R0T2W4Y9';
const input = { id: '01J8ZQK7V0A2M4N6P8R0T2W4Y8', tenantId: 'tenant-a', requestNumber: 'SRC-6P8R0T2W4Y', title: '短视频剪辑季度寻源', serviceCategoryCode: 'video_editing', mode: 'directed_quote' as const, budgetCeilingMinor: '500000', currency: 'CNY' as const, ownerEmployeeId: 'employee-1', responsibleDepartmentId: 'department-1', responseDueAt: '2026-08-20T00:00:00.000Z', invitedSupplierIds: [SUPPLIER] };
describe('Sourcing 领域', () => {
  it('完成审批发布、供应响应、评估与选定，成交额不超过预算', () => {
    const published = publishSourcing(submitSourcing(createSourcingDraft(input, NOW), NOW), 'approval-1', NOW);
    const responded = recordSourcingResponse(published, { supplierId: SUPPLIER, quotationMinor: '420000', proposalRef: 'proposal-1', eligibilityDigest: 'a'.repeat(43), supplierVersion: 3 }, NOW);
    const evaluating = startSourcingEvaluation(responded, NOW);
    const awarded = awardSourcing(evaluating, { supplierId: SUPPLIER, agreedAmountMinor: '400000', decisionEvidenceRef: 'decision-1', eligibilityDigest: 'b'.repeat(43), supplierVersion: 3 }, NOW);
    expect(awarded).toMatchObject({ status: 'awarded', award: { supplierId: SUPPLIER, agreedAmountMinor: '400000' } });
    expect(Object.isFrozen(awarded.responses)).toBe(true);
  });
  it('拒绝未邀约供应方、重复响应、浮点金额与预算超额选定', () => {
    const published = publishSourcing(submitSourcing(createSourcingDraft(input, NOW), NOW), 'approval-1', NOW);
    expect(() => recordSourcingResponse(published, { supplierId: '01J8ZQK7V0A2M4N6P8R0T2W4Y7', quotationMinor: '1', proposalRef: 'proposal-1', eligibilityDigest: 'a'.repeat(43), supplierVersion: 1 }, NOW)).toThrow('SOURCING_SUPPLIER_NOT_INVITED');
    expect(() => createSourcingDraft({ ...input, budgetCeilingMinor: '12.5' }, NOW)).toThrow('SOURCING_MONEY_INVALID');
    const response = recordSourcingResponse(published, { supplierId: SUPPLIER, quotationMinor: '420000', proposalRef: 'proposal-1', eligibilityDigest: 'a'.repeat(43), supplierVersion: 3 }, NOW);
    expect(() => recordSourcingResponse(response, { supplierId: SUPPLIER, quotationMinor: '410000', proposalRef: 'proposal-2', eligibilityDigest: 'a'.repeat(43), supplierVersion: 3 }, NOW)).toThrow('SOURCING_RESPONSE_DUPLICATE');
    expect(() => awardSourcing(startSourcingEvaluation(response, NOW), { supplierId: SUPPLIER, agreedAmountMinor: '500001', decisionEvidenceRef: 'decision-1', eligibilityDigest: 'b'.repeat(43), supplierVersion: 3 }, NOW)).toThrow('SOURCING_AWARD_BUDGET_EXCEEDED');
  });
});
