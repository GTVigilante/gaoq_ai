export type SupplierStatus = 'draft' | 'under_review' | 'active' | 'rejected' | 'suspended' | 'closed';
export type SupplierPartyKind = 'individual' | 'organization';

export interface SupplierCapabilityView {
  readonly serviceCategoryCode: string;
  readonly level: 'basic' | 'verified' | 'preferred' | 'strategic';
  readonly evidenceRef: string | null;
  readonly validUntil: string | null;
}

export interface SupplierRateView {
  readonly serviceCategoryCode: string;
  readonly unit: 'per_piece' | 'per_minute' | 'per_day' | 'per_project' | 'per_hour';
  readonly amountMinor: string;
  readonly currency: 'CNY';
  readonly taxIncluded: boolean;
  readonly validFrom: string;
  readonly validUntil: string | null;
}

export interface SupplierQualificationView {
  readonly type: 'identity' | 'business_registration' | 'authority' | 'contract_terms' | 'tax_profile' | 'conflict_review';
  readonly verifiedAt: string;
  readonly validUntil: string | null;
}

export interface SupplierView {
  readonly id: string; readonly supplierNumber: string; readonly partyKind: SupplierPartyKind;
  readonly legalForm: 'individual' | 'sole_proprietor' | 'studio' | 'company' | 'agency';
  readonly displayName: string; readonly identityHint: string; readonly ownerEmployeeId: string;
  readonly responsibleDepartmentId: string; readonly riskTier: 'low' | 'medium' | 'high';
  readonly status: SupplierStatus; readonly capabilities: readonly SupplierCapabilityView[];
  readonly rates: readonly SupplierRateView[]; readonly qualifications: readonly SupplierQualificationView[];
  readonly statusReasonCode: string | null; readonly version: number;
  readonly createdAt: string; readonly updatedAt: string;
}

export interface SupplierSearchView {
  readonly items: readonly SupplierView[];
  readonly nextCursor: string | null;
}

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const RESOURCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CODE = /^[a-z][a-z0-9_.:-]{1,63}$/u;
const MONEY = /^(0|[1-9][0-9]{0,14})$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** 浏览器信任边界：拒绝额外字段、原型污染、无界数组与非法金额。 */
export function parseSupplierSearch(value: unknown): SupplierSearchView {
  const record = object(value); exact(record, ['items', 'nextCursor']);
  const values = array(record.items, 100, parseSupplier); unique(values.map((item) => item.id));
  return Object.freeze({ items: Object.freeze(values), nextCursor: nullablePattern(record.nextCursor, ULID) });
}

export function parseSupplierWrite(value: unknown): { readonly supplier: SupplierView } {
  const record = object(value); exact(record, ['supplier']);
  return Object.freeze({ supplier: parseSupplier(record.supplier) });
}

function parseSupplier(value: unknown): SupplierView {
  const item = object(value); exact(item, [
    'id', 'supplierNumber', 'partyKind', 'legalForm', 'displayName', 'identityHint', 'ownerEmployeeId',
    'responsibleDepartmentId', 'riskTier', 'status', 'capabilities', 'rates', 'qualifications',
    'statusReasonCode', 'version', 'createdAt', 'updatedAt',
  ]);
  const capabilities = array(item.capabilities, 50, parseCapability);
  const rates = array(item.rates, 100, parseRate);
  const qualifications = array(item.qualifications, 6, parseQualification);
  unique(capabilities.map((entry) => entry.serviceCategoryCode));
  unique(rates.map((entry) => `${entry.serviceCategoryCode}:${entry.unit}:${entry.validFrom}`));
  unique(qualifications.map((entry) => entry.type));
  return Object.freeze({
    id: pattern(item.id, ULID), supplierNumber: pattern(item.supplierNumber, /^SUP-[A-Z0-9]{10}$/u),
    partyKind: enumeration(item.partyKind, ['individual', 'organization']),
    legalForm: enumeration(item.legalForm, ['individual', 'sole_proprietor', 'studio', 'company', 'agency']),
    displayName: bounded(item.displayName, 1, 128), identityHint: bounded(item.identityHint, 4, 16),
    ownerEmployeeId: pattern(item.ownerEmployeeId, RESOURCE), responsibleDepartmentId: pattern(item.responsibleDepartmentId, RESOURCE),
    riskTier: enumeration(item.riskTier, ['low', 'medium', 'high']),
    status: enumeration(item.status, ['draft', 'under_review', 'active', 'rejected', 'suspended', 'closed']),
    capabilities: Object.freeze(capabilities), rates: Object.freeze(rates), qualifications: Object.freeze(qualifications),
    statusReasonCode: nullablePattern(item.statusReasonCode, /^[a-z][a-z0-9_]{2,63}$/u),
    version: integer(item.version, 1, Number.MAX_SAFE_INTEGER - 1), createdAt: pattern(item.createdAt, ISO), updatedAt: pattern(item.updatedAt, ISO),
  });
}

function parseCapability(value: unknown): SupplierCapabilityView {
  const item = object(value); exact(item, ['serviceCategoryCode', 'level', 'evidenceRef', 'validUntil']);
  return Object.freeze({ serviceCategoryCode: pattern(item.serviceCategoryCode, CODE), level: enumeration(item.level, ['basic', 'verified', 'preferred', 'strategic']), evidenceRef: nullablePattern(item.evidenceRef, RESOURCE), validUntil: nullablePattern(item.validUntil, DATE) });
}

function parseRate(value: unknown): SupplierRateView {
  const item = object(value); exact(item, ['serviceCategoryCode', 'unit', 'amountMinor', 'currency', 'taxIncluded', 'validFrom', 'validUntil']);
  return Object.freeze({ serviceCategoryCode: pattern(item.serviceCategoryCode, CODE), unit: enumeration(item.unit, ['per_piece', 'per_minute', 'per_day', 'per_project', 'per_hour']), amountMinor: pattern(item.amountMinor, MONEY), currency: literal(item.currency, 'CNY'), taxIncluded: boolean(item.taxIncluded), validFrom: pattern(item.validFrom, DATE), validUntil: nullablePattern(item.validUntil, DATE) });
}

function parseQualification(value: unknown): SupplierQualificationView {
  const item = object(value); exact(item, ['type', 'verifiedAt', 'validUntil']);
  return Object.freeze({ type: enumeration(item.type, ['identity', 'business_registration', 'authority', 'contract_terms', 'tax_profile', 'conflict_review']), verifiedAt: pattern(item.verifiedAt, ISO), validUntil: nullablePattern(item.validUntil, DATE) });
}

function object(value: unknown): Record<string, unknown> { if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, keys: readonly string[]): void { const actual = Reflect.ownKeys(value); if (actual.some((key) => typeof key !== 'string') || actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) fail(); }
function array<T>(value: unknown, maximum: number, parser: (entry: unknown) => T): T[] { if (!Array.isArray(value) || value.length > maximum || Object.getPrototypeOf(value) !== Array.prototype) fail(); return value.map(parser); }
function unique(values: readonly string[]): void { if (new Set(values).size !== values.length) fail(); }
function pattern(value: unknown, expression: RegExp): string { if (typeof value !== 'string' || !expression.test(value)) fail(); return value; }
function nullablePattern(value: unknown, expression: RegExp): string | null { return value === null ? null : pattern(value, expression); }
function bounded(value: unknown, minimum: number, maximum: number): string { if (typeof value !== 'string' || value.length < minimum || value.length > maximum) fail(); return value; }
function enumeration<const T extends string>(value: unknown, values: readonly T[]): T { if (typeof value !== 'string' || !values.includes(value as T)) fail(); return value as T; }
function literal<const T extends string>(value: unknown, expected: T): T { if (value !== expected) fail(); return expected; }
function integer(value: unknown, minimum: number, maximum: number): number { if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) fail(); return value as number; }
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') fail(); return value; }
function fail(): never { throw new Error('SUPPLIER_BROWSER_CONTRACT_INVALID'); }
