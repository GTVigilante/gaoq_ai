export type SupplierMemberPermission =
  'profile_read' | 'catalog_manage' | 'opportunities_read' |
  'response_submit' | 'delivery_submit' | 'income_read';

export interface SupplierMemberView {
  readonly id: string; readonly supplierId: string; readonly actorId: string;
  readonly performerRef: string; readonly role: 'owner' | 'manager' | 'performer';
  readonly permissions: readonly SupplierMemberPermission[];
  readonly validFrom: string; readonly validUntil: string | null;
  readonly status: 'active' | 'revoked'; readonly revokedReasonCode: string | null;
  readonly version: number; readonly createdAt: string; readonly updatedAt: string;
}

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const REASON = /^[a-z][a-z0-9_]{2,63}$/u;
const PERMISSIONS = [
  'profile_read', 'catalog_manage', 'opportunities_read',
  'response_submit', 'delivery_submit', 'income_read',
] as const;

export function parseSupplierMemberList(value: unknown): { readonly items: readonly SupplierMemberView[] } {
  const root = object(value); exact(root, ['items']);
  const items = array(root.items, 100, parseMember);
  if (new Set(items.map((item) => item.id)).size !== items.length) fail();
  return Object.freeze({ items: Object.freeze(items) });
}

export function parseSupplierMemberWrite(value: unknown): { readonly member: SupplierMemberView } {
  const root = object(value); exact(root, ['member']);
  return Object.freeze({ member: parseMember(root.member) });
}

function parseMember(value: unknown): SupplierMemberView {
  const item = object(value); exact(item, [
    'id', 'supplierId', 'actorId', 'performerRef', 'role', 'permissions', 'validFrom',
    'validUntil', 'status', 'revokedReasonCode', 'version', 'createdAt', 'updatedAt',
  ]);
  const permissions = array(item.permissions, 6, (entry) => enumeration(entry, PERMISSIONS));
  if (permissions.length < 1 || new Set(permissions).size !== permissions.length) fail();
  return Object.freeze({
    id: string(item.id, ULID), supplierId: string(item.supplierId, ULID),
    actorId: string(item.actorId, ID), performerRef: string(item.performerRef, ID),
    role: enumeration(item.role, ['owner', 'manager', 'performer']),
    permissions: Object.freeze(permissions), validFrom: string(item.validFrom, DATE),
    validUntil: item.validUntil === null ? null : string(item.validUntil, DATE),
    status: enumeration(item.status, ['active', 'revoked']),
    revokedReasonCode: item.revokedReasonCode === null ? null : string(item.revokedReasonCode, REASON),
    version: integer(item.version), createdAt: string(item.createdAt, ISO),
    updatedAt: string(item.updatedAt, ISO),
  });
}

function object(value: unknown): Record<string, unknown> { if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, keys: readonly string[]): void { const actual = Reflect.ownKeys(value); if (actual.length !== keys.length || actual.some((key) => typeof key !== 'string') || keys.some((key) => !Object.hasOwn(value, key))) fail(); }
function array<T>(value: unknown, maximum: number, parser: (entry: unknown) => T): T[] { if (!Array.isArray(value) || value.length > maximum || Object.getPrototypeOf(value) !== Array.prototype) fail(); return value.map(parser); }
function string(value: unknown, pattern: RegExp): string { if (typeof value !== 'string' || !pattern.test(value)) fail(); return value; }
function enumeration<const T extends string>(value: unknown, values: readonly T[]): T { if (typeof value !== 'string' || !values.includes(value as T)) fail(); return value as T; }
function integer(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 1) fail(); return value as number; }
function fail(): never { throw new Error('SUPPLIER_MEMBER_BROWSER_CONTRACT_INVALID'); }
