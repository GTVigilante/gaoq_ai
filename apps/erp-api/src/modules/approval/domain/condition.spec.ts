import { describe, expect, it } from 'vitest';

import {
  evaluateApprovalCondition,
  validateApprovalCondition,
  type ApprovalCondition,
  type ApprovalFormData,
} from './condition.js';
import { ApprovalDomainError } from './approval.errors.js';

const FIELDS = new Set(['amount', 'category', 'tags', 'remark']);

describe('审批受限条件 DSL', () => {
  it('只解释受支持运算符并组合计算结果', () => {
    const condition: ApprovalCondition = {
      op: 'and',
      conditions: [
        { op: 'gte', field: 'amount', value: 100_00 },
        { op: 'in', field: 'category', values: ['travel', 'purchase'] },
        { op: 'not', condition: { op: 'is_empty', field: 'remark' } },
      ],
    };

    expect(evaluateApprovalCondition(condition, {
      amount: 150_00,
      category: 'travel',
      remark: '客户现场',
    }, FIELDS)).toBe(true);
  });

  it('数组相等使用严格顺序，in 可命中多选项', () => {
    const data: ApprovalFormData = { tags: ['urgent', 'finance'] };
    expect(evaluateApprovalCondition(
      { op: 'eq', field: 'tags', value: ['urgent', 'finance'] }, data, FIELDS,
    )).toBe(true);
    expect(evaluateApprovalCondition(
      { op: 'eq', field: 'tags', value: ['finance', 'urgent'] }, data, FIELDS,
    )).toBe(false);
    expect(evaluateApprovalCondition(
      { op: 'in', field: 'tags', values: ['finance'] }, data, FIELDS,
    )).toBe(true);
  });

  it('拒绝字段白名单外引用和非有限数', () => {
    expect(() => validateApprovalCondition(
      { op: 'eq', field: 'password', value: 'x' }, FIELDS,
    )).toThrowError(expect.objectContaining({ code: 'APPROVAL_CONDITION_FIELD_DENIED' }));
    expect(() => validateApprovalCondition(
      { op: 'gt', field: 'amount', value: Number.POSITIVE_INFINITY }, FIELDS,
    )).toThrowError(ApprovalDomainError);
    expect(() => validateApprovalCondition(
      { op: 'execute_script', source: 'return true' } as never, FIELDS,
    )).toThrowError(expect.objectContaining({ code: 'APPROVAL_CONDITION_INVALID' }));
    expect(() => validateApprovalCondition(
      { op: 'and', conditions: 'not-an-array' } as never, FIELDS,
    )).toThrowError(expect.objectContaining({ code: 'APPROVAL_CONDITION_INVALID' }));
  });

  it('拒绝过深和超量条件，限制解释器资源消耗', () => {
    let condition: ApprovalCondition = { op: 'eq', field: 'amount', value: 1 };
    for (let index = 0; index < 12; index += 1) condition = { op: 'not', condition };

    expect(() => validateApprovalCondition(condition, FIELDS)).toThrowError(
      expect.objectContaining({ code: 'APPROVAL_CONDITION_TOO_COMPLEX' }),
    );
    expect(() => validateApprovalCondition({
      op: 'and',
      conditions: Array.from({ length: 21 }, () => ({
        op: 'eq' as const,
        field: 'amount',
        value: 1,
      })),
    }, FIELDS)).toThrowError(expect.objectContaining({ code: 'APPROVAL_CONDITION_INVALID' }));
  });

  it('不读取原型链属性，避免属性路径与原型污染旁路', () => {
    const inherited = Object.create({ amount: 999 }) as Record<string, unknown>;
    expect(evaluateApprovalCondition(
      { op: 'is_empty', field: 'amount' }, inherited as ApprovalFormData, FIELDS,
    )).toBe(true);
  });
});
