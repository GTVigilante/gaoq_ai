export type SupplierIncomeStatus =
  'prepared' | 'pending_approval' | 'approved' | 'submitted' | 'paid' | 'failed' | 'frozen';

export interface SupplierIncomeView {
  readonly summary: {
    readonly grossAmountMinor: string; readonly withholdingAmountMinor: string;
    readonly netAmountMinor: string; readonly awaitingAmountMinor: string;
    readonly processingAmountMinor: string; readonly paidAmountMinor: string;
    readonly attentionAmountMinor: string; readonly currency: 'CNY'; readonly itemCount: number;
  };
  readonly items: readonly {
    readonly id: string; readonly payableNumber: string; readonly engagementId: string;
    readonly grossAmountMinor: string; readonly withholdingAmountMinor: string;
    readonly netAmountMinor: string; readonly currency: 'CNY'; readonly status: SupplierIncomeStatus;
    readonly failureCode: string | null; readonly updatedAt: string;
  }[];
}

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const MONEY = /^(0|[1-9][0-9]{0,14})$/u;
const TOTAL = /^(0|[1-9][0-9]{0,17})$/u;
const NUMBER = /^PAY-[0-9A-HJKMNP-TV-Z]{10}$/u;
const CODE = /^[a-z][a-z0-9_.:-]{1,63}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** 校验收益最小投影及其金额汇总闭包，拒绝部分或错配的财务事实。 */
export function parseSupplierIncome(value: unknown): SupplierIncomeView {
  const root = object(value); exact(root, ['summary', 'items']);
  const items = array(root.items, 500, (entry) => {
    const item = object(entry); exact(item, [
      'id', 'payableNumber', 'engagementId', 'grossAmountMinor', 'withholdingAmountMinor',
      'netAmountMinor', 'currency', 'status', 'failureCode', 'updatedAt',
    ]);
    const gross = string(item.grossAmountMinor, MONEY);
    const withholding = string(item.withholdingAmountMinor, MONEY);
    const net = string(item.netAmountMinor, MONEY);
    if (BigInt(gross) - BigInt(withholding) !== BigInt(net)) fail();
    return Object.freeze({
      id: string(item.id, ULID), payableNumber: string(item.payableNumber, NUMBER),
      engagementId: string(item.engagementId, ULID), grossAmountMinor: gross,
      withholdingAmountMinor: withholding, netAmountMinor: net,
      currency: literal(item.currency, 'CNY'),
      status: enumeration(item.status, [
        'prepared', 'pending_approval', 'approved', 'submitted', 'paid', 'failed', 'frozen',
      ]),
      failureCode: item.failureCode === null ? null : string(item.failureCode, CODE),
      updatedAt: string(item.updatedAt, ISO),
    });
  });
  if (new Set(items.map((item) => item.id)).size !== items.length) fail();
  const summary = object(root.summary); exact(summary, [
    'grossAmountMinor', 'withholdingAmountMinor', 'netAmountMinor', 'awaitingAmountMinor',
    'processingAmountMinor', 'paidAmountMinor', 'attentionAmountMinor', 'currency', 'itemCount',
  ]);
  const parsedSummary = Object.freeze({
    grossAmountMinor: string(summary.grossAmountMinor, TOTAL),
    withholdingAmountMinor: string(summary.withholdingAmountMinor, TOTAL),
    netAmountMinor: string(summary.netAmountMinor, TOTAL),
    awaitingAmountMinor: string(summary.awaitingAmountMinor, TOTAL),
    processingAmountMinor: string(summary.processingAmountMinor, TOTAL),
    paidAmountMinor: string(summary.paidAmountMinor, TOTAL),
    attentionAmountMinor: string(summary.attentionAmountMinor, TOTAL),
    currency: literal(summary.currency, 'CNY'), itemCount: integer(summary.itemCount, 0, 500),
  });
  const totals = items.reduce((current, item) => {
    current.gross += BigInt(item.grossAmountMinor);
    current.withholding += BigInt(item.withholdingAmountMinor);
    current.net += BigInt(item.netAmountMinor);
    if (['prepared', 'pending_approval', 'approved'].includes(item.status)) current.awaiting += BigInt(item.netAmountMinor);
    else if (item.status === 'submitted') current.processing += BigInt(item.netAmountMinor);
    else if (item.status === 'paid') current.paid += BigInt(item.netAmountMinor);
    else current.attention += BigInt(item.netAmountMinor);
    return current;
  }, { gross: 0n, withholding: 0n, net: 0n, awaiting: 0n, processing: 0n, paid: 0n, attention: 0n });
  if (parsedSummary.itemCount !== items.length ||
      parsedSummary.grossAmountMinor !== totals.gross.toString() ||
      parsedSummary.withholdingAmountMinor !== totals.withholding.toString() ||
      parsedSummary.netAmountMinor !== totals.net.toString() ||
      parsedSummary.awaitingAmountMinor !== totals.awaiting.toString() ||
      parsedSummary.processingAmountMinor !== totals.processing.toString() ||
      parsedSummary.paidAmountMinor !== totals.paid.toString() ||
      parsedSummary.attentionAmountMinor !== totals.attention.toString()) fail();
  return Object.freeze({ summary: parsedSummary, items: Object.freeze(items) });
}

function object(value: unknown): Record<string, unknown> { if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, keys: readonly string[]): void { const actual = Reflect.ownKeys(value); if (actual.length !== keys.length || actual.some((key) => typeof key !== 'string') || keys.some((key) => !Object.hasOwn(value, key))) fail(); }
function array<T>(value: unknown, maximum: number, parser: (entry: unknown) => T): T[] { if (!Array.isArray(value) || value.length > maximum || Object.getPrototypeOf(value) !== Array.prototype) fail(); return value.map(parser); }
function string(value: unknown, pattern: RegExp): string { if (typeof value !== 'string' || !pattern.test(value)) fail(); return value; }
function literal<const T extends string>(value: unknown, expected: T): T { if (value !== expected) fail(); return expected; }
function enumeration<const T extends string>(value: unknown, values: readonly T[]): T { if (typeof value !== 'string' || !values.includes(value as T)) fail(); return value as T; }
function integer(value: unknown, minimum: number, maximum: number): number { if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) fail(); return value as number; }
function fail(): never { throw new Error('SUPPLIER_INCOME_BROWSER_CONTRACT_INVALID'); }
