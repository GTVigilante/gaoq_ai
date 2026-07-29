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

  it('完整覆盖标量、空值、逻辑短路与数值比较语义', () => {
    const data: ApprovalFormData = {
      amount: 100, category: 'travel', tags: [], remark: null,
    };
    const cases: Array<[ApprovalCondition, boolean]> = [
      [{ op: 'or', conditions: [
        { op: 'eq', field: 'category', value: 'other' },
        { op: 'ne', field: 'category', value: 'other' },
      ] }, true],
      [{ op: 'is_empty', field: 'remark' }, true],
      [{ op: 'is_empty', field: 'tags' }, true],
      [{ op: 'is_empty', field: 'category' }, false],
      [{ op: 'in', field: 'category', values: ['purchase'] }, false],
      [{ op: 'in', field: 'remark', values: [null] }, true],
      [{ op: 'gt', field: 'amount', value: 99 }, true],
      [{ op: 'gte', field: 'amount', value: 100 }, true],
      [{ op: 'lt', field: 'amount', value: 101 }, true],
      [{ op: 'lte', field: 'amount', value: 100 }, true],
      [{ op: 'gt', field: 'category', value: 1 }, false],
      [{ op: 'eq', field: 'tags', value: 'not-array' }, false],
    ];
    for (const [condition, expected] of cases) {
      expect(evaluateApprovalCondition(condition, data, FIELDS)).toBe(expected);
    }
  });

  it('拒绝非纯对象、空逻辑、非法 not/in/标量和超长条件数组', () => {
    const inherited = Object.create({ op: 'eq' }) as ApprovalCondition;
    const invalid: unknown[] = [
      null,
      [],
      inherited,
      { op: 'and', conditions: [] },
      { op: 'not', condition: null },
      { op: 'in', field: 'category', values: [] },
      { op: 'in', field: 'category', values: Array.from({ length: 51 }, () => 'x') },
      { op: 'eq', field: 'category', value: { unsafe: true } },
      { op: 'eq', field: 'tags', value: Array.from({ length: 201 }, () => 'x') },
      { op: 'eq', field: 'tags', value: [Number.POSITIVE_INFINITY] },
      { op: 'eq', field: 'BadField', value: 'x' },
    ];
    for (const condition of invalid) {
      expect(() => validateApprovalCondition(condition as ApprovalCondition, FIELDS))
        .toThrowError(ApprovalDomainError);
    }
  });
});
