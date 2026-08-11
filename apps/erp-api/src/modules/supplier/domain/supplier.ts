import { createHash } from 'node:crypto';

export const SUPPLIER_PARTY_KINDS = ['individual', 'organization'] as const;
export const SUPPLIER_LEGAL_FORMS = ['individual', 'sole_proprietor', 'studio', 'company', 'agency'] as const;
export const SUPPLIER_STATUSES = ['draft', 'under_review', 'active', 'suspended', 'closed', 'rejected'] as const;
export const SUPPLIER_RISK_TIERS = ['low', 'medium', 'high'] as const;
export const SUPPLIER_CAPABILITY_LEVELS = ['basic', 'verified', 'preferred', 'strategic'] as const;
export const SUPPLIER_RATE_UNITS = ['per_piece', 'per_minute', 'per_day', 'per_project', 'per_hour'] as const;
export const SUPPLIER_QUALIFICATION_TYPES = [
  'identity', 'business_registration', 'authority', 'contract_terms', 'tax_profile', 'conflict_review',
] as const;

export type SupplierPartyKind = (typeof SUPPLIER_PARTY_KINDS)[number];
export type SupplierLegalForm = (typeof SUPPLIER_LEGAL_FORMS)[number];
export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number];
export type SupplierRiskTier = (typeof SUPPLIER_RISK_TIERS)[number];
export type SupplierCapabilityLevel = (typeof SUPPLIER_CAPABILITY_LEVELS)[number];
export type SupplierRateUnit = (typeof SUPPLIER_RATE_UNITS)[number];
export type SupplierQualificationType = (typeof SUPPLIER_QUALIFICATION_TYPES)[number];

export interface SupplierCapability {
  readonly serviceCategoryCode: string;
  readonly level: SupplierCapabilityLevel;
  readonly evidenceRef: string | null;
  readonly validUntil: string | null;
}

export interface SupplierRateItem {
  readonly serviceCategoryCode: string;
  readonly unit: SupplierRateUnit;
  readonly amountMinor: string;
  readonly currency: 'CNY';
  readonly taxIncluded: boolean;
  readonly validFrom: string;
  readonly validUntil: string | null;
}

export interface SupplierQualification {
  readonly type: SupplierQualificationType;
  readonly evidenceRef: string;
  readonly verifiedAt: string;
  readonly validUntil: string | null;
}

export interface SupplierRelationship {
  readonly id: string;
  readonly tenantId: string;
  readonly supplierNumber: string;
  readonly partyKind: SupplierPartyKind;
  readonly legalForm: SupplierLegalForm;
  readonly displayName: string;
  readonly identityFingerprint: string;
  readonly identityHint: string;
  readonly ownerEmployeeId: string;
  readonly responsibleDepartmentId: string;
  readonly riskTier: SupplierRiskTier;
  readonly status: SupplierStatus;
  readonly capabilities: readonly SupplierCapability[];
  readonly rates: readonly SupplierRateItem[];
  readonly qualifications: readonly SupplierQualification[];
  readonly decisionEvidenceRef: string | null;
  readonly statusReasonCode: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SupplierDraftInput {
  readonly id: string;
  readonly tenantId: string;
  readonly supplierNumber: string;
  readonly partyKind: SupplierPartyKind;
  readonly legalForm: SupplierLegalForm;
  readonly displayName: string;
  readonly identityFingerprint: string;
  readonly identityHint: string;
  readonly ownerEmployeeId: string;
  readonly responsibleDepartmentId: string;
  readonly riskTier: SupplierRiskTier;
  readonly capabilities: readonly SupplierCapability[];
  readonly rates: readonly SupplierRateItem[];
}

export interface SupplierEligibilitySnapshot {
  readonly supplierId: string;
  readonly supplierVersion: number;
  readonly purpose: string;
  readonly serviceCategoryCode: string;
  readonly evaluatedAt: string;
  readonly eligible: boolean;
  readonly reasonCodes: readonly string[];
  readonly digest: string;
}

export interface SupplierQualificationExpiryReview {
  readonly kind: 'expiring' | 'expired';
  readonly effectiveOn: string;
  readonly sourceCodes: readonly string[];
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const SUPPLIER_NUMBER = /^SUP-[0-9A-HJKMNP-TV-Z]{10}$/;
const CODE = /^[a-z][a-z0-9_.:-]{1,63}$/;
const DISPLAY_NAME = /^.{2,128}$/u;
const HINT = /^\*{4}.{2,8}$/u;
const FINGERPRINT = /^[A-Za-z0-9._:-]{1,64}\.[A-Za-z0-9_-]{43}$/;
const MONEY = /^(0|[1-9][0-9]{0,14})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const REASON = /^[a-z][a-z0-9_]{2,63}$/;

/** 创建供应关系草稿；所有集合在进入聚合前完成精确、去重和冻结。 */
export function createSupplierDraft(input: SupplierDraftInput, now: Date): SupplierRelationship {
  assertId(input.id, true);
  assertId(input.tenantId);
  if (!SUPPLIER_NUMBER.test(input.supplierNumber)) fail('SUPPLIER_NUMBER_INVALID');
  assertPartyShape(input.partyKind, input.legalForm);
  const displayName = normalizeDisplayName(input.displayName);
  if (!FINGERPRINT.test(input.identityFingerprint) || !HINT.test(input.identityHint)) fail('SUPPLIER_IDENTITY_REFERENCE_INVALID');
  assertId(input.ownerEmployeeId); assertId(input.responsibleDepartmentId);
  const capabilities = normalizeCapabilities(input.capabilities);
  const rates = normalizeRates(input.rates, capabilities);
  const occurredAt = canonicalTime(now);
  return freezeSupplier({
    ...input,
    displayName,
    capabilities,
    rates,
    qualifications: Object.freeze([]),
    status: 'draft',
    decisionEvidenceRef: null,
    statusReasonCode: null,
    version: 1,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
}

/** 仅草稿可修订；身份指纹由应用模块在加密后替换。 */
export function reviseSupplierDraft(
  current: SupplierRelationship,
  input: Omit<SupplierDraftInput, 'id' | 'tenantId' | 'supplierNumber'>,
  now: Date,
): SupplierRelationship {
  if (current.status !== 'draft') fail('SUPPLIER_DRAFT_STATE_INVALID');
  assertPartyShape(input.partyKind, input.legalForm);
  if (!FINGERPRINT.test(input.identityFingerprint) || !HINT.test(input.identityHint)) fail('SUPPLIER_IDENTITY_REFERENCE_INVALID');
  assertId(input.ownerEmployeeId); assertId(input.responsibleDepartmentId);
  const capabilities = normalizeCapabilities(input.capabilities);
  return freezeSupplier({
    ...current,
    ...input,
    displayName: normalizeDisplayName(input.displayName),
    capabilities,
    rates: normalizeRates(input.rates, capabilities),
    version: nextVersion(current.version),
    updatedAt: nextTime(current.updatedAt, now),
  });
}

/** 版本化替换服务能力；已关闭、驳回及复核中的关系禁止绕过重新决策修改。 */
export function replaceSupplierCapabilities(
  current: SupplierRelationship,
  values: readonly SupplierCapability[],
  now: Date,
): SupplierRelationship {
  if (!['draft', 'active', 'suspended'].includes(current.status)) fail('SUPPLIER_CAPABILITY_STATE_INVALID');
  const capabilities = normalizeCapabilities(values);
  return advance(current, { capabilities, rates: normalizeRates(current.rates, capabilities) }, now);
}

/** 版本化替换参考价目；价目只属于目录事实，不能直接形成成交或应付金额。 */
export function replaceSupplierRates(
  current: SupplierRelationship,
  values: readonly SupplierRateItem[],
  now: Date,
): SupplierRelationship {
  if (!['draft', 'active', 'suspended'].includes(current.status)) fail('SUPPLIER_RATE_STATE_INVALID');
  return advance(current, { rates: normalizeRates(values, current.capabilities) }, now);
}

/** 提交准入复核；至少声明一项有效服务能力。 */
export function submitSupplier(current: SupplierRelationship, now: Date): SupplierRelationship {
  if (current.status !== 'draft' || current.capabilities.length === 0) fail('SUPPLIER_SUBMIT_STATE_INVALID');
  return advance(current, { status: 'under_review', statusReasonCode: null }, now);
}

/** 以独立审批证据和完整准入结论激活供应关系。 */
export function approveSupplier(
  current: SupplierRelationship,
  qualifications: readonly SupplierQualification[],
  decisionEvidenceRef: string,
  now: Date,
): SupplierRelationship {
  if (current.status !== 'under_review') fail('SUPPLIER_DECISION_STATE_INVALID');
  assertId(decisionEvidenceRef);
  const normalized = normalizeQualifications(qualifications, now);
  const required = requiredQualifications(current.partyKind);
  if (!required.every((type) => normalized.some((item) => item.type === type))) fail('SUPPLIER_QUALIFICATION_INCOMPLETE');
  return advance(current, {
    status: 'active', qualifications: normalized, decisionEvidenceRef, statusReasonCode: null,
  }, now);
}

/** 拒绝准入；拒绝是终态且必须使用稳定原因码。 */
export function rejectSupplier(current: SupplierRelationship, decisionEvidenceRef: string, reasonCode: string, now: Date): SupplierRelationship {
  if (current.status !== 'under_review') fail('SUPPLIER_DECISION_STATE_INVALID');
  assertId(decisionEvidenceRef);
  assertReason(reasonCode);
  return advance(current, { status: 'rejected', decisionEvidenceRef, statusReasonCode: reasonCode }, now);
}

/** 暂停活动供应关系，不改写历史准入证据。 */
export function suspendSupplier(current: SupplierRelationship, reasonCode: string, now: Date): SupplierRelationship {
  if (current.status !== 'active') fail('SUPPLIER_SUSPEND_STATE_INVALID');
  assertReason(reasonCode);
  return advance(current, { status: 'suspended', statusReasonCode: reasonCode }, now);
}

/** 完成独立复核后恢复供应关系。 */
export function reactivateSupplier(current: SupplierRelationship, decisionEvidenceRef: string, now: Date): SupplierRelationship {
  if (current.status !== 'suspended') fail('SUPPLIER_REACTIVATE_STATE_INVALID');
  assertId(decisionEvidenceRef);
  const checked = eligibilityReasons(current, current.capabilities[0]?.serviceCategoryCode ?? '', now.toISOString(), true);
  if (checked.length > 0) fail('SUPPLIER_REACTIVATE_QUALIFICATION_INVALID');
  return advance(current, { status: 'active', decisionEvidenceRef, statusReasonCode: null }, now);
}

/** 关闭供应关系；草稿、复核中、活动和暂停状态均可显式终止。 */
export function closeSupplier(current: SupplierRelationship, reasonCode: string, now: Date): SupplierRelationship {
  if (!['draft', 'under_review', 'active', 'suspended'].includes(current.status)) fail('SUPPLIER_CLOSE_STATE_INVALID');
  assertReason(reasonCode);
  return advance(current, { status: 'closed', statusReasonCode: reasonCode }, now);
}

/** 解析给定用途和服务分类的资格快照；调用方只消费冻结结论。 */
export function resolveSupplierEligibility(
  supplier: SupplierRelationship,
  purpose: string,
  serviceCategoryCode: string,
  at: Date,
): SupplierEligibilitySnapshot {
  if (!CODE.test(purpose) || !CODE.test(serviceCategoryCode)) fail('SUPPLIER_ELIGIBILITY_INPUT_INVALID');
  const evaluatedAt = canonicalTime(at);
  const reasonCodes = Object.freeze(eligibilityReasons(supplier, serviceCategoryCode, evaluatedAt, false));
  const canonical = JSON.stringify([
    'gaoq-supplier-eligibility-v1', supplier.tenantId, supplier.id, supplier.version, purpose,
    serviceCategoryCode, evaluatedAt, reasonCodes,
  ]);
  return Object.freeze({
    supplierId: supplier.id,
    supplierVersion: supplier.version,
    purpose,
    serviceCategoryCode,
    evaluatedAt,
    eligible: reasonCodes.length === 0,
    reasonCodes,
    digest: createHash('sha256').update(canonical, 'utf8').digest('base64url'),
  });
}

/** 每日资格到期复核；仅在固定提醒日产生 expiring，过期后产生 expired。 */
export function reviewSupplierQualificationExpiry(
  supplier: SupplierRelationship,
  today: string,
): SupplierQualificationExpiryReview | null {
  assertDate(today);
  if (supplier.status !== 'active') return null;
  const dates = [
    ...supplier.qualifications
      .filter((item) => requiredQualifications(supplier.partyKind).includes(item.type))
      .filter((item): item is SupplierQualification & { readonly validUntil: string } => item.validUntil !== null)
      .map((item) => ({ code: `qualification:${item.type}`, date: item.validUntil })),
    ...supplier.capabilities
      .filter((item): item is SupplierCapability & { readonly validUntil: string } => item.validUntil !== null)
      .map((item) => ({ code: `capability:${item.serviceCategoryCode}`, date: item.validUntil })),
  ];
  if (dates.length === 0) return null;
  const earliest = dates.reduce((left, right) => left.date <= right.date ? left : right);
  const sourceCodes = Object.freeze(dates.filter((item) => item.date === earliest.date).map((item) => item.code).sort());
  const remaining = Math.round((Date.parse(`${earliest.date}T00:00:00.000Z`) - Date.parse(`${today}T00:00:00.000Z`)) / 86_400_000);
  if (remaining < 0) return Object.freeze({ kind: 'expired', effectiveOn: earliest.date, sourceCodes });
  if (![30, 14, 7, 1, 0].includes(remaining)) return null;
  return Object.freeze({ kind: 'expiring', effectiveOn: earliest.date, sourceCodes });
}

/** 从持久化边界恢复聚合；任何错位字段或状态组合均整体失败关闭。 */
export function restoreSupplierRelationship(value: SupplierRelationship): SupplierRelationship {
  if (!isExactObject(value, [
    'id', 'tenantId', 'supplierNumber', 'partyKind', 'legalForm', 'displayName', 'identityFingerprint',
    'identityHint', 'ownerEmployeeId', 'responsibleDepartmentId', 'riskTier', 'status', 'capabilities', 'rates', 'qualifications',
    'decisionEvidenceRef', 'statusReasonCode', 'version', 'createdAt', 'updatedAt',
  ])) fail('SUPPLIER_PERSISTED_SHAPE_INVALID');
  assertId(value.id, true); assertId(value.tenantId); assertId(value.ownerEmployeeId); assertId(value.responsibleDepartmentId);
  if (!SUPPLIER_NUMBER.test(value.supplierNumber)) fail('SUPPLIER_NUMBER_INVALID');
  assertPartyShape(value.partyKind, value.legalForm);
  if (!SUPPLIER_RISK_TIERS.includes(value.riskTier) || !SUPPLIER_STATUSES.includes(value.status)) fail('SUPPLIER_STATE_INVALID');
  const createdAt = canonicalIso(value.createdAt); const updatedAt = canonicalIso(value.updatedAt);
  if (updatedAt < createdAt || !Number.isSafeInteger(value.version) || value.version < 1) fail('SUPPLIER_VERSION_INVALID');
  if (!FINGERPRINT.test(value.identityFingerprint) || !HINT.test(value.identityHint)) fail('SUPPLIER_IDENTITY_REFERENCE_INVALID');
  const capabilities = normalizeCapabilities(value.capabilities);
  const rates = normalizeRates(value.rates, capabilities);
  const qualifications = value.qualifications.length === 0
    ? Object.freeze([])
    : normalizeQualifications(value.qualifications, new Date(updatedAt));
  const hasDecision = value.decisionEvidenceRef !== null;
  if (hasDecision) assertId(value.decisionEvidenceRef);
  if (value.statusReasonCode !== null) assertReason(value.statusReasonCode);
  const validState =
    (value.status === 'draft' && qualifications.length === 0 && !hasDecision && value.statusReasonCode === null) ||
    (value.status === 'under_review' && qualifications.length === 0 && !hasDecision && value.statusReasonCode === null) ||
    (value.status === 'active' && qualifications.length > 0 && hasDecision && value.statusReasonCode === null) ||
    (value.status === 'suspended' && qualifications.length > 0 && hasDecision && value.statusReasonCode !== null) ||
    (value.status === 'rejected' && hasDecision && value.statusReasonCode !== null) ||
    (value.status === 'closed' && value.statusReasonCode !== null);
  if (!validState) fail('SUPPLIER_STATE_INVARIANT_INVALID');
  if (['active', 'suspended'].includes(value.status)) {
    const required = requiredQualifications(value.partyKind);
    if (!required.every((type) => qualifications.some((item) => item.type === type))) fail('SUPPLIER_QUALIFICATION_INCOMPLETE');
  }
  return freezeSupplier({ ...value, displayName: normalizeDisplayName(value.displayName), capabilities, rates, qualifications });
}

function eligibilityReasons(supplier: SupplierRelationship, category: string, at: string, ignoreStatus: boolean): string[] {
  const reasons: string[] = [];
  if (!ignoreStatus && supplier.status !== 'active') reasons.push('supplier_not_active');
  const capability = supplier.capabilities.find((item) => item.serviceCategoryCode === category);
  if (capability === undefined) reasons.push('capability_missing');
  else if (capability.validUntil !== null && capability.validUntil < at.slice(0, 10)) reasons.push('capability_expired');
  for (const type of requiredQualifications(supplier.partyKind)) {
    const qualification = supplier.qualifications.find((item) => item.type === type);
    if (qualification === undefined) reasons.push(`qualification_${type}_missing`);
    else if (qualification.validUntil !== null && qualification.validUntil < at.slice(0, 10)) reasons.push(`qualification_${type}_expired`);
  }
  return [...new Set(reasons)].sort();
}

function requiredQualifications(kind: SupplierPartyKind): readonly SupplierQualificationType[] {
  return kind === 'individual'
    ? ['identity', 'contract_terms', 'tax_profile', 'conflict_review']
    : ['business_registration', 'authority', 'contract_terms', 'tax_profile'];
}

function normalizeCapabilities(values: unknown): readonly SupplierCapability[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 50) fail('SUPPLIER_CAPABILITIES_INVALID');
  const seen = new Set<string>();
  const normalized = values.map((value) => {
    if (!isSupplierCapability(value)) fail('SUPPLIER_CAPABILITY_SHAPE_INVALID');
    if (!CODE.test(value.serviceCategoryCode) || !SUPPLIER_CAPABILITY_LEVELS.includes(value.level)) fail('SUPPLIER_CAPABILITY_INVALID');
    if (value.evidenceRef !== null) assertId(value.evidenceRef);
    if (value.validUntil !== null) assertDate(value.validUntil);
    if (seen.has(value.serviceCategoryCode)) fail('SUPPLIER_CAPABILITY_DUPLICATE');
    seen.add(value.serviceCategoryCode);
    return Object.freeze({ ...value });
  });
  return Object.freeze(normalized.sort((left, right) => left.serviceCategoryCode.localeCompare(right.serviceCategoryCode)));
}

function normalizeRates(values: unknown, capabilities: readonly SupplierCapability[]): readonly SupplierRateItem[] {
  if (!Array.isArray(values) || values.length > 100) fail('SUPPLIER_RATES_INVALID');
  const categories = new Set(capabilities.map((item) => item.serviceCategoryCode));
  const seen = new Set<string>();
  const normalized = values.map((value) => {
    if (!isSupplierRateItem(value)) fail('SUPPLIER_RATE_SHAPE_INVALID');
    if (!CODE.test(value.serviceCategoryCode) || !categories.has(value.serviceCategoryCode) || !SUPPLIER_RATE_UNITS.includes(value.unit)) fail('SUPPLIER_RATE_INVALID');
    if (!MONEY.test(value.amountMinor) || value.currency !== 'CNY' || typeof value.taxIncluded !== 'boolean') fail('SUPPLIER_RATE_AMOUNT_INVALID');
    assertDate(value.validFrom);
    if (value.validUntil !== null) {
      assertDate(value.validUntil);
      if (value.validUntil < value.validFrom) fail('SUPPLIER_RATE_RANGE_INVALID');
    }
    const key = `${value.serviceCategoryCode}:${value.unit}`;
    if (seen.has(key)) fail('SUPPLIER_RATE_DUPLICATE');
    seen.add(key);
    return Object.freeze({ ...value });
  });
  return Object.freeze(normalized.sort((left, right) => `${left.serviceCategoryCode}:${left.unit}`.localeCompare(`${right.serviceCategoryCode}:${right.unit}`)));
}

function normalizeQualifications(values: unknown, now: Date): readonly SupplierQualification[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > SUPPLIER_QUALIFICATION_TYPES.length) fail('SUPPLIER_QUALIFICATIONS_INVALID');
  const nowIso = canonicalTime(now);
  const seen = new Set<string>();
  const normalized = values.map((value) => {
    if (!isSupplierQualification(value)) fail('SUPPLIER_QUALIFICATION_SHAPE_INVALID');
    if (!SUPPLIER_QUALIFICATION_TYPES.includes(value.type)) fail('SUPPLIER_QUALIFICATION_INVALID');
    assertId(value.evidenceRef);
    const verifiedAt = canonicalIso(value.verifiedAt);
    if (verifiedAt > nowIso) fail('SUPPLIER_QUALIFICATION_TIME_INVALID');
    if (value.validUntil !== null) {
      assertDate(value.validUntil);
      if (value.validUntil < verifiedAt.slice(0, 10)) fail('SUPPLIER_QUALIFICATION_RANGE_INVALID');
    }
    if (seen.has(value.type)) fail('SUPPLIER_QUALIFICATION_DUPLICATE');
    seen.add(value.type);
    return Object.freeze({ ...value, verifiedAt });
  });
  return Object.freeze(normalized.sort((left, right) => left.type.localeCompare(right.type)));
}

function assertPartyShape(kind: SupplierPartyKind, form: SupplierLegalForm): void {
  if (!SUPPLIER_PARTY_KINDS.includes(kind) || !SUPPLIER_LEGAL_FORMS.includes(form)) fail('SUPPLIER_PARTY_INVALID');
  if ((kind === 'individual') !== (form === 'individual')) fail('SUPPLIER_PARTY_LEGAL_FORM_MISMATCH');
}

function normalizeDisplayName(value: string): string {
  if (typeof value !== 'string') fail('SUPPLIER_DISPLAY_NAME_INVALID');
  const normalized = value.trim().normalize('NFC');
  if (!DISPLAY_NAME.test(normalized) || containsControlCharacter(normalized)) fail('SUPPLIER_DISPLAY_NAME_INVALID');
  return normalized;
}

function freezeSupplier(value: SupplierRelationship): SupplierRelationship {
  return Object.freeze({
    ...value,
    capabilities: Object.freeze(value.capabilities.map((item) => Object.freeze({ ...item }))),
    rates: Object.freeze(value.rates.map((item) => Object.freeze({ ...item }))),
    qualifications: Object.freeze(value.qualifications.map((item) => Object.freeze({ ...item }))),
  });
}

function advance(current: SupplierRelationship, patch: Partial<SupplierRelationship>, now: Date): SupplierRelationship {
  return freezeSupplier({ ...current, ...patch, version: nextVersion(current.version), updatedAt: nextTime(current.updatedAt, now) });
}

function nextVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) fail('SUPPLIER_VERSION_INVALID');
  return value + 1;
}

function nextTime(previous: string, now: Date): string {
  const next = canonicalTime(now);
  if (next < canonicalIso(previous)) fail('SUPPLIER_TIME_REGRESSION');
  return next;
}

function canonicalTime(value: Date): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) fail('SUPPLIER_TIME_INVALID');
  return value.toISOString();
}

function canonicalIso(value: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) fail('SUPPLIER_TIME_INVALID');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) fail('SUPPLIER_TIME_INVALID');
  return value;
}

function assertDate(value: string): void {
  if (!DATE.test(value)) fail('SUPPLIER_DATE_INVALID');
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) fail('SUPPLIER_DATE_INVALID');
}

function assertId(value: string, ulid = false): void {
  if (typeof value !== 'string' || !(ulid ? ULID : ID).test(value)) fail('SUPPLIER_ID_INVALID');
}

function assertReason(value: string): void {
  if (!REASON.test(value)) fail('SUPPLIER_REASON_INVALID');
}

function isExactObject(value: unknown, keys: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isSupplierCapability(value: unknown): value is SupplierCapability {
  return isExactObject(value, ['serviceCategoryCode', 'level', 'evidenceRef', 'validUntil']);
}

function isSupplierRateItem(value: unknown): value is SupplierRateItem {
  return isExactObject(value, ['serviceCategoryCode', 'unit', 'amountMinor', 'currency', 'taxIncluded', 'validFrom', 'validUntil']);
}

function isSupplierQualification(value: unknown): value is SupplierQualification {
  return isExactObject(value, ['type', 'evidenceRef', 'verifiedAt', 'validUntil']);
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function fail(code: string): never {
  throw new Error(code);
}
