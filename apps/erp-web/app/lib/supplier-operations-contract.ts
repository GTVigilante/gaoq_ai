const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MONEY = /^(0|[1-9][0-9]{0,14})$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const ENGAGEMENT_STATUSES = ['draft', 'pending_approval', 'pending_signature', 'active', 'delivered', 'accepted', 'disputed', 'cancelled'] as const;
const PAYABLE_STATUSES = ['prepared', 'pending_approval', 'approved', 'submitted', 'paid', 'failed', 'frozen'] as const;

export type EngagementStatus = (typeof ENGAGEMENT_STATUSES)[number];
export type PayableStatus = (typeof PAYABLE_STATUSES)[number];

export interface EngagementOperationsView {
  readonly id: string; readonly engagementNumber: string; readonly sourcingRequestId: string;
  readonly supplierId: string; readonly serviceCategoryCode: string;
  readonly agreedAmountMinor: string; readonly currency: 'CNY';
  readonly responsibleDepartmentId: string; readonly ownerEmployeeId: string;
  readonly performerRefs: readonly string[];
  readonly deliveries: readonly { readonly version: number; readonly submittedAt: string }[];
  readonly status: EngagementStatus; readonly statusReasonCode: string | null;
  readonly version: number; readonly createdAt: string; readonly updatedAt: string;
}

export interface PayableOperationsView {
  readonly id: string; readonly payableNumber: string; readonly engagementId: string;
  readonly engagementVersion: number; readonly supplierId: string;
  readonly grossAmountMinor: string; readonly withholdingAmountMinor: string;
  readonly netAmountMinor: string; readonly currency: 'CNY'; readonly taxTreatmentCode: string;
  readonly treasuryInstructionRef: string | null; readonly status: PayableStatus;
  readonly failureCode: string | null; readonly version: number;
  readonly createdAt: string; readonly updatedAt: string;
}

/** 严格解析履约运营列表，拒绝跨租户错位响应无法识别，但可拒绝结构和金额语义漂移。 */
export function parseEngagementOperationsSearch(value: unknown): {
  readonly items: readonly EngagementOperationsView[]; readonly nextCursor: string | null;
} {
  const root = exact(value, ['items', 'nextCursor'], 'ENGAGEMENT_SEARCH_RESPONSE_INVALID');
  if (!Array.isArray(root.items) || root.items.length > 100) fail('ENGAGEMENT_SEARCH_RESPONSE_INVALID');
  const items = Object.freeze(root.items.map(parseEngagement));
  return Object.freeze({ items, nextCursor: nullableCursor(root.nextCursor, 'ENGAGEMENT_SEARCH_RESPONSE_INVALID') });
}

/** 严格解析应付运营列表，并重算整数分净额以防响应漂移。 */
export function parsePayableOperationsSearch(value: unknown): {
  readonly items: readonly PayableOperationsView[]; readonly nextCursor: string | null;
} {
  const root = exact(value, ['items', 'nextCursor'], 'PAYABLE_SEARCH_RESPONSE_INVALID');
  if (!Array.isArray(root.items) || root.items.length > 100) fail('PAYABLE_SEARCH_RESPONSE_INVALID');
  const items = Object.freeze(root.items.map(parsePayable));
  return Object.freeze({ items, nextCursor: nullableCursor(root.nextCursor, 'PAYABLE_SEARCH_RESPONSE_INVALID') });
}

export function parseEngagementOperationsWrite(value: unknown): EngagementOperationsView {
  return parseEngagement(exact(value, ['engagement'], 'ENGAGEMENT_WRITE_RESPONSE_INVALID').engagement);
}

export function parsePayableOperationsWrite(value: unknown): PayableOperationsView {
  return parsePayable(exact(value, ['payable'], 'PAYABLE_WRITE_RESPONSE_INVALID').payable);
}

function parseEngagement(value: unknown): EngagementOperationsView {
  const row = exact(value, [
    'id', 'engagementNumber', 'sourcingRequestId', 'supplierId', 'serviceCategoryCode',
    'agreedAmountMinor', 'currency', 'responsibleDepartmentId', 'ownerEmployeeId',
    'performerRefs', 'deliveries', 'status', 'statusReasonCode', 'version', 'createdAt', 'updatedAt',
  ], 'ENGAGEMENT_RESPONSE_INVALID');
  if (!ULID.test(text(row.id)) || !ID.test(text(row.engagementNumber)) ||
    !ULID.test(text(row.sourcingRequestId)) || !ULID.test(text(row.supplierId)) ||
    !ID.test(text(row.serviceCategoryCode)) || !MONEY.test(text(row.agreedAmountMinor)) ||
    row.currency !== 'CNY' || !ID.test(text(row.responsibleDepartmentId)) ||
    !ID.test(text(row.ownerEmployeeId)) || !isVersion(row.version) ||
    !ENGAGEMENT_STATUSES.includes(row.status as EngagementStatus) ||
    !nullableId(row.statusReasonCode) || !isTime(row.createdAt) || !isTime(row.updatedAt)) {
    fail('ENGAGEMENT_RESPONSE_INVALID');
  }
  if (!Array.isArray(row.performerRefs) || row.performerRefs.length > 50 ||
    new Set(row.performerRefs).size !== row.performerRefs.length ||
    !row.performerRefs.every((entry) => typeof entry === 'string' && ID.test(entry)) ||
    !Array.isArray(row.deliveries) || row.deliveries.length > 100) fail('ENGAGEMENT_RESPONSE_INVALID');
  const deliveries = Object.freeze(row.deliveries.map((entry, index) => {
    const delivery = exact(entry, ['version', 'submittedAt'], 'ENGAGEMENT_RESPONSE_INVALID');
    if (delivery.version !== index + 1 || !isTime(delivery.submittedAt)) fail('ENGAGEMENT_RESPONSE_INVALID');
    return Object.freeze({ version: delivery.version, submittedAt: delivery.submittedAt as string });
  }));
  return Object.freeze({
    id: row.id as string, engagementNumber: row.engagementNumber as string,
    sourcingRequestId: row.sourcingRequestId as string, supplierId: row.supplierId as string,
    serviceCategoryCode: row.serviceCategoryCode as string,
    agreedAmountMinor: row.agreedAmountMinor as string, currency: 'CNY',
    responsibleDepartmentId: row.responsibleDepartmentId as string,
    ownerEmployeeId: row.ownerEmployeeId as string,
    performerRefs: Object.freeze([...(row.performerRefs as string[])]), deliveries,
    status: row.status as EngagementStatus, statusReasonCode: row.statusReasonCode as string | null,
    version: row.version as number, createdAt: row.createdAt as string, updatedAt: row.updatedAt as string,
  });
}

function parsePayable(value: unknown): PayableOperationsView {
  const row = exact(value, [
    'id', 'payableNumber', 'engagementId', 'engagementVersion', 'supplierId', 'grossAmountMinor',
    'withholdingAmountMinor', 'netAmountMinor', 'currency', 'taxTreatmentCode',
    'treasuryInstructionRef', 'status', 'failureCode', 'version', 'createdAt', 'updatedAt',
  ], 'PAYABLE_RESPONSE_INVALID');
  if (!ULID.test(text(row.id)) || !ID.test(text(row.payableNumber)) ||
    !ULID.test(text(row.engagementId)) || !isVersion(row.engagementVersion) ||
    !ULID.test(text(row.supplierId)) || !MONEY.test(text(row.grossAmountMinor)) ||
    !MONEY.test(text(row.withholdingAmountMinor)) || !MONEY.test(text(row.netAmountMinor)) ||
    BigInt(row.grossAmountMinor as string) - BigInt(row.withholdingAmountMinor as string) !==
      BigInt(row.netAmountMinor as string) || row.currency !== 'CNY' ||
    !ID.test(text(row.taxTreatmentCode)) || !nullableId(row.treasuryInstructionRef) ||
    !PAYABLE_STATUSES.includes(row.status as PayableStatus) || !nullableId(row.failureCode) ||
    !isVersion(row.version) || !isTime(row.createdAt) || !isTime(row.updatedAt)) {
    fail('PAYABLE_RESPONSE_INVALID');
  }
  return Object.freeze({
    id: row.id as string, payableNumber: row.payableNumber as string,
    engagementId: row.engagementId as string, engagementVersion: row.engagementVersion as number,
    supplierId: row.supplierId as string, grossAmountMinor: row.grossAmountMinor as string,
    withholdingAmountMinor: row.withholdingAmountMinor as string,
    netAmountMinor: row.netAmountMinor as string, currency: 'CNY',
    taxTreatmentCode: row.taxTreatmentCode as string,
    treasuryInstructionRef: row.treasuryInstructionRef as string | null,
    status: row.status as PayableStatus, failureCode: row.failureCode as string | null,
    version: row.version as number, createdAt: row.createdAt as string, updatedAt: row.updatedAt as string,
  });
}

function exact(value: unknown, keys: readonly string[], code: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) fail(code);
  const row = value as Readonly<Record<string, unknown>>;
  const own = Reflect.ownKeys(row);
  if (own.some((key) => typeof key !== 'string') || own.length !== keys.length ||
    keys.some((key) => !Object.hasOwn(row, key))) fail(code);
  return row;
}
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function nullableId(value: unknown): boolean { return value === null || (typeof value === 'string' && ID.test(value)); }
function nullableCursor(value: unknown, code: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !ULID.test(value)) fail(code);
  return value;
}
function isVersion(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 1; }
function isTime(value: unknown): boolean { return typeof value === 'string' && ISO.test(value) && !Number.isNaN(Date.parse(value)); }
function fail(code: string): never { throw new Error(code); }
