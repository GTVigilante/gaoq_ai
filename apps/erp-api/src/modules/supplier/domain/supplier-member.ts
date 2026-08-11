export const SUPPLIER_MEMBER_ROLES = ['owner', 'manager', 'performer'] as const;
export const SUPPLIER_MEMBER_PERMISSIONS = [
  'profile_read',
  'catalog_manage',
  'opportunities_read',
  'response_submit',
  'delivery_submit',
  'income_read',
] as const;
export const SUPPLIER_MEMBER_STATUSES = ['active', 'revoked'] as const;

export type SupplierMemberRole = (typeof SUPPLIER_MEMBER_ROLES)[number];
export type SupplierMemberPermission = (typeof SUPPLIER_MEMBER_PERMISSIONS)[number];
export type SupplierMemberStatus = (typeof SUPPLIER_MEMBER_STATUSES)[number];

export interface SupplierMemberRelationship {
  readonly id: string;
  readonly tenantId: string;
  readonly supplierId: string;
  readonly actorId: string;
  readonly performerRef: string;
  readonly role: SupplierMemberRole;
  readonly permissions: readonly SupplierMemberPermission[];
  readonly evidenceRef: string;
  readonly validFrom: string;
  readonly validUntil: string | null;
  readonly status: SupplierMemberStatus;
  readonly revokedReasonCode: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type SupplierMemberInput = Pick<
  SupplierMemberRelationship,
  'id' | 'tenantId' | 'supplierId' | 'actorId' | 'performerRef' | 'role' |
  'permissions' | 'evidenceRef' | 'validFrom' | 'validUntil'
>;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const REASON = /^[a-z][a-z0-9_]{2,63}$/u;

/** 创建供应方成员授权；所有权限显式列举，不从角色名称隐式扩张。 */
export function createSupplierMember(
  input: SupplierMemberInput,
  now: Date,
): SupplierMemberRelationship {
  id(input.id, true); id(input.tenantId); id(input.supplierId, true);
  id(input.actorId); id(input.performerRef); id(input.evidenceRef);
  if (!SUPPLIER_MEMBER_ROLES.includes(input.role)) fail('SUPPLIER_MEMBER_ROLE_INVALID');
  const permissions = normalizePermissions(input.permissions);
  if (input.role === 'owner' &&
      SUPPLIER_MEMBER_PERMISSIONS.some((permission) => !permissions.includes(permission))) {
    fail('SUPPLIER_MEMBER_OWNER_PERMISSIONS_INCOMPLETE');
  }
  if (!permissions.includes('profile_read')) {
    fail('SUPPLIER_MEMBER_PROFILE_PERMISSION_MISSING');
  }
  if (input.role === 'performer' && permissions.some((permission) =>
    ['catalog_manage', 'response_submit', 'income_read'].includes(permission))) {
    fail('SUPPLIER_MEMBER_PERMISSION_ESCALATION');
  }
  if (input.role === 'performer' && !permissions.includes('delivery_submit')) {
    fail('SUPPLIER_MEMBER_PERFORMER_PERMISSION_MISSING');
  }
  date(input.validFrom);
  if (input.validUntil !== null) {
    date(input.validUntil);
    if (input.validUntil < input.validFrom) fail('SUPPLIER_MEMBER_VALIDITY_INVALID');
  }
  const occurredAt = time(now);
  return freeze({
    ...input,
    permissions,
    status: 'active',
    revokedReasonCode: null,
    version: 1,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
}

export function revokeSupplierMember(
  current: SupplierMemberRelationship,
  reasonCode: string,
  now: Date,
): SupplierMemberRelationship {
  if (current.status !== 'active') fail('SUPPLIER_MEMBER_REVOKE_STATE_INVALID');
  if (!REASON.test(reasonCode)) fail('SUPPLIER_MEMBER_REASON_INVALID');
  if (current.version >= Number.MAX_SAFE_INTEGER) fail('SUPPLIER_MEMBER_VERSION_INVALID');
  const updatedAt = time(now);
  if (updatedAt < current.updatedAt) fail('SUPPLIER_MEMBER_TIME_REGRESSION');
  return freeze({
    ...current,
    status: 'revoked',
    revokedReasonCode: reasonCode,
    version: current.version + 1,
    updatedAt,
  });
}

export function restoreSupplierMember(value: SupplierMemberRelationship): SupplierMemberRelationship {
  if (!exact(value, [
    'id', 'tenantId', 'supplierId', 'actorId', 'performerRef', 'role', 'permissions',
    'evidenceRef', 'validFrom', 'validUntil', 'status', 'revokedReasonCode', 'version',
    'createdAt', 'updatedAt',
  ])) fail('SUPPLIER_MEMBER_PERSISTED_SHAPE_INVALID');
  const base = createSupplierMember({
    id: value.id, tenantId: value.tenantId, supplierId: value.supplierId,
    actorId: value.actorId, performerRef: value.performerRef, role: value.role,
    permissions: value.permissions, evidenceRef: value.evidenceRef,
    validFrom: value.validFrom, validUntil: value.validUntil,
  }, new Date(value.createdAt));
  if (!Number.isSafeInteger(value.version) || value.version < 1 ||
      iso(value.updatedAt) < iso(value.createdAt)) fail('SUPPLIER_MEMBER_PERSISTED_STATE_INVALID');
  if (value.status === 'active') {
    if (value.revokedReasonCode !== null || value.version < 1) fail('SUPPLIER_MEMBER_STATE_INVARIANT_INVALID');
  } else if (value.status === 'revoked') {
    if (value.revokedReasonCode === null || !REASON.test(value.revokedReasonCode) || value.version < 2) {
      fail('SUPPLIER_MEMBER_STATE_INVARIANT_INVALID');
    }
  } else fail('SUPPLIER_MEMBER_STATUS_INVALID');
  return freeze({ ...base, ...value });
}

export function isSupplierMemberActiveAt(
  member: SupplierMemberRelationship,
  at: string,
): boolean {
  const timestamp = iso(at);
  const day = timestamp.slice(0, 10);
  return member.status === 'active' && member.validFrom <= day &&
    (member.validUntil === null || member.validUntil >= day);
}

function normalizePermissions(values: unknown): readonly SupplierMemberPermission[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > SUPPLIER_MEMBER_PERMISSIONS.length ||
      values.some((value) => typeof value !== 'string' ||
        !SUPPLIER_MEMBER_PERMISSIONS.some((permission) => permission === value))) {
    fail('SUPPLIER_MEMBER_PERMISSIONS_INVALID');
  }
  const normalized = values.map((value) => {
    const permission = typeof value === 'string'
      ? SUPPLIER_MEMBER_PERMISSIONS.find((candidate) => candidate === value)
      : undefined;
    if (permission === undefined) fail('SUPPLIER_MEMBER_PERMISSIONS_INVALID');
    return permission;
  });
  if (new Set(normalized).size !== normalized.length) fail('SUPPLIER_MEMBER_PERMISSIONS_DUPLICATE');
  return Object.freeze([...normalized].sort());
}

function freeze(value: SupplierMemberRelationship): SupplierMemberRelationship {
  return Object.freeze({ ...value, permissions: Object.freeze([...value.permissions]) });
}
function id(value: string, ulid = false): void {
  if (typeof value !== 'string' || !(ulid ? ULID : ID).test(value)) fail('SUPPLIER_MEMBER_ID_INVALID');
}
function date(value: string): void {
  if (!DATE.test(value)) fail('SUPPLIER_MEMBER_DATE_INVALID');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail('SUPPLIER_MEMBER_DATE_INVALID');
  }
}
function iso(value: string): string {
  const parsed = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    fail('SUPPLIER_MEMBER_TIME_INVALID');
  }
  return value;
}
function time(value: Date): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) fail('SUPPLIER_MEMBER_TIME_INVALID');
  return value.toISOString();
}
function exact(value: unknown, keys: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key) => typeof key === 'string') &&
    keys.every((key) => Object.hasOwn(value, key));
}
function fail(code: string): never { throw new Error(code); }
