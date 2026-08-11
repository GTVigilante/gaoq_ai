export const SOURCING_MODES = ['open_invitation', 'directed_quote', 'direct_award', 'framework_calloff'] as const;
export const SOURCING_STATUSES = ['draft', 'pending_approval', 'published', 'evaluating', 'awarded', 'closed', 'cancelled'] as const;
export type SourcingMode = (typeof SOURCING_MODES)[number];
export type SourcingStatus = (typeof SOURCING_STATUSES)[number];

export interface SourcingResponse {
  readonly supplierId: string; readonly quotationMinor: string; readonly proposalRef: string;
  readonly eligibilityDigest: string; readonly supplierVersion: number; readonly submittedAt: string;
}
export interface SourcingAward {
  readonly supplierId: string; readonly agreedAmountMinor: string; readonly decisionEvidenceRef: string;
  readonly eligibilityDigest: string; readonly supplierVersion: number; readonly awardedAt: string;
}
export interface SourcingRequest {
  readonly id: string; readonly tenantId: string; readonly requestNumber: string; readonly title: string;
  readonly serviceCategoryCode: string; readonly mode: SourcingMode; readonly budgetCeilingMinor: string;
  readonly currency: 'CNY'; readonly ownerEmployeeId: string; readonly responsibleDepartmentId: string;
  readonly responseDueAt: string; readonly invitedSupplierIds: readonly string[]; readonly responses: readonly SourcingResponse[];
  readonly approvalEvidenceRef: string | null; readonly award: SourcingAward | null;
  readonly status: SourcingStatus; readonly statusReasonCode: string | null; readonly version: number;
  readonly createdAt: string; readonly updatedAt: string;
}
export type SourcingDraftInput = Pick<SourcingRequest, 'id' | 'tenantId' | 'requestNumber' | 'title' | 'serviceCategoryCode' | 'mode' | 'budgetCeilingMinor' | 'currency' | 'ownerEmployeeId' | 'responsibleDepartmentId' | 'responseDueAt' | 'invitedSupplierIds'>;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u; const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const NUMBER = /^SRC-[0-9A-HJKMNP-TV-Z]{10}$/u; const CODE = /^[a-z][a-z0-9_.:-]{1,63}$/u; const MONEY = /^(0|[1-9][0-9]{0,14})$/u;
const DIGEST = /^[A-Za-z0-9_-]{43}$/u; const REASON = /^[a-z][a-z0-9_]{2,63}$/u;

/** 创建寻源草稿；预算上限仍是控制量，不是成交价。 */
export function createSourcingDraft(input: SourcingDraftInput, now: Date): SourcingRequest {
  id(input.id, true); id(input.tenantId); if (!NUMBER.test(input.requestNumber)) fail('SOURCING_NUMBER_INVALID');
  const title = text(input.title, 2, 160); if (!CODE.test(input.serviceCategoryCode) || !SOURCING_MODES.includes(input.mode)) fail('SOURCING_INPUT_INVALID');
  money(input.budgetCeilingMinor); if (input.currency !== 'CNY') fail('SOURCING_CURRENCY_INVALID'); id(input.ownerEmployeeId); id(input.responsibleDepartmentId);
  const responseDueAt = iso(input.responseDueAt); const occurredAt = time(now); if (responseDueAt <= occurredAt) fail('SOURCING_DUE_AT_INVALID');
  const invitedSupplierIds = ids(input.invitedSupplierIds, 100);
  if (['directed_quote', 'direct_award', 'framework_calloff'].includes(input.mode) && invitedSupplierIds.length === 0) fail('SOURCING_INVITATION_REQUIRED');
  return freeze({ ...input, title, responseDueAt, invitedSupplierIds, responses: [], approvalEvidenceRef: null, award: null, status: 'draft', statusReasonCode: null, version: 1, createdAt: occurredAt, updatedAt: occurredAt });
}

export function submitSourcing(current: SourcingRequest, now: Date): SourcingRequest { if (current.status !== 'draft') fail('SOURCING_SUBMIT_STATE_INVALID'); return advance(current, { status: 'pending_approval' }, now); }
export function publishSourcing(current: SourcingRequest, approvalEvidenceRef: string, now: Date): SourcingRequest { if (current.status !== 'pending_approval') fail('SOURCING_PUBLISH_STATE_INVALID'); id(approvalEvidenceRef); return advance(current, { status: 'published', approvalEvidenceRef }, now); }

/** 登记供应响应时冻结当次资格摘要；响应报价不覆盖供应方参考价目。 */
export function recordSourcingResponse(current: SourcingRequest, input: Omit<SourcingResponse, 'submittedAt'>, now: Date): SourcingRequest {
  if (current.status !== 'published') fail('SOURCING_RESPONSE_STATE_INVALID'); id(input.supplierId, true); money(input.quotationMinor); id(input.proposalRef); digest(input.eligibilityDigest); version(input.supplierVersion);
  if (current.mode !== 'open_invitation' && !current.invitedSupplierIds.includes(input.supplierId)) fail('SOURCING_SUPPLIER_NOT_INVITED');
  if (current.responses.some((entry) => entry.supplierId === input.supplierId)) fail('SOURCING_RESPONSE_DUPLICATE');
  if (current.responses.length >= 100) fail('SOURCING_RESPONSE_LIMIT'); const submittedAt = time(now); if (submittedAt > current.responseDueAt) fail('SOURCING_RESPONSE_LATE');
  return advance(current, { responses: Object.freeze([...current.responses, Object.freeze({ ...input, submittedAt })].sort((left, right) => left.supplierId.localeCompare(right.supplierId))) }, now);
}

export function startSourcingEvaluation(current: SourcingRequest, now: Date): SourcingRequest { if (current.status !== 'published' || current.responses.length === 0) fail('SOURCING_EVALUATION_STATE_INVALID'); return advance(current, { status: 'evaluating' }, now); }

export function awardSourcing(current: SourcingRequest, input: Omit<SourcingAward, 'awardedAt'>, now: Date): SourcingRequest {
  if (current.status !== 'evaluating') fail('SOURCING_AWARD_STATE_INVALID'); id(input.supplierId, true); money(input.agreedAmountMinor); id(input.decisionEvidenceRef); digest(input.eligibilityDigest); version(input.supplierVersion);
  const response = current.responses.find((entry) => entry.supplierId === input.supplierId); if (response === undefined) fail('SOURCING_AWARD_RESPONSE_MISSING');
  if (BigInt(input.agreedAmountMinor) > BigInt(current.budgetCeilingMinor)) fail('SOURCING_AWARD_BUDGET_EXCEEDED');
  return advance(current, { status: 'awarded', award: Object.freeze({ ...input, awardedAt: time(now) }) }, now);
}

export function cancelSourcing(current: SourcingRequest, reasonCode: string, now: Date): SourcingRequest { if (!['draft', 'pending_approval', 'published', 'evaluating'].includes(current.status)) fail('SOURCING_CANCEL_STATE_INVALID'); reason(reasonCode); return advance(current, { status: 'cancelled', statusReasonCode: reasonCode }, now); }
export function closeSourcing(current: SourcingRequest, now: Date): SourcingRequest { if (current.status !== 'awarded') fail('SOURCING_CLOSE_STATE_INVALID'); return advance(current, { status: 'closed' }, now); }

/** 持久化边界恢复时重新验证完整引用闭包与状态组合。 */
export function restoreSourcing(value: SourcingRequest): SourcingRequest {
  if (!exact(value, ['id','tenantId','requestNumber','title','serviceCategoryCode','mode','budgetCeilingMinor','currency','ownerEmployeeId','responsibleDepartmentId','responseDueAt','invitedSupplierIds','responses','approvalEvidenceRef','award','status','statusReasonCode','version','createdAt','updatedAt'])) fail('SOURCING_PERSISTED_SHAPE_INVALID');
  const base = createSourcingDraft({ id: value.id, tenantId: value.tenantId, requestNumber: value.requestNumber, title: value.title, serviceCategoryCode: value.serviceCategoryCode, mode: value.mode, budgetCeilingMinor: value.budgetCeilingMinor, currency: value.currency, ownerEmployeeId: value.ownerEmployeeId, responsibleDepartmentId: value.responsibleDepartmentId, responseDueAt: value.responseDueAt, invitedSupplierIds: value.invitedSupplierIds }, new Date(value.createdAt));
  if (!SOURCING_STATUSES.includes(value.status) || !Number.isSafeInteger(value.version) || value.version < 1 || iso(value.updatedAt) < base.createdAt) fail('SOURCING_PERSISTED_STATE_INVALID');
  const responses = value.responses.map((entry) => response(entry)); if (new Set(responses.map((entry) => entry.supplierId)).size !== responses.length) fail('SOURCING_RESPONSE_DUPLICATE');
  const approval = value.approvalEvidenceRef; if (approval !== null) id(approval); const award = value.award === null ? null : awardValue(value.award);
  if (value.statusReasonCode !== null) reason(value.statusReasonCode);
  const valid = (['draft','pending_approval'].includes(value.status) && approval === null && award === null) || (['published','evaluating'].includes(value.status) && approval !== null && award === null) || (['awarded','closed'].includes(value.status) && approval !== null && award !== null) || (value.status === 'cancelled' && value.statusReasonCode !== null);
  if (!valid) fail('SOURCING_STATE_INVARIANT_INVALID'); return freeze({ ...value, ...base, responses, approvalEvidenceRef: approval, award, status: value.status, statusReasonCode: value.statusReasonCode, version: value.version, updatedAt: value.updatedAt });
}

function response(value: SourcingResponse): SourcingResponse { if (!exact(value, ['supplierId','quotationMinor','proposalRef','eligibilityDigest','supplierVersion','submittedAt'])) fail('SOURCING_RESPONSE_SHAPE_INVALID'); id(value.supplierId, true); money(value.quotationMinor); id(value.proposalRef); digest(value.eligibilityDigest); version(value.supplierVersion); return Object.freeze({ ...value, submittedAt: iso(value.submittedAt) }); }
function awardValue(value: SourcingAward): SourcingAward { if (!exact(value, ['supplierId','agreedAmountMinor','decisionEvidenceRef','eligibilityDigest','supplierVersion','awardedAt'])) fail('SOURCING_AWARD_SHAPE_INVALID'); id(value.supplierId, true); money(value.agreedAmountMinor); id(value.decisionEvidenceRef); digest(value.eligibilityDigest); version(value.supplierVersion); return Object.freeze({ ...value, awardedAt: iso(value.awardedAt) }); }
function advance(current: SourcingRequest, patch: Partial<SourcingRequest>, now: Date): SourcingRequest { if (current.version >= Number.MAX_SAFE_INTEGER) fail('SOURCING_VERSION_INVALID'); const updatedAt = time(now); if (updatedAt < current.updatedAt) fail('SOURCING_TIME_REGRESSION'); return freeze({ ...current, ...patch, version: current.version + 1, updatedAt }); }
function freeze(value: SourcingRequest): SourcingRequest { return Object.freeze({ ...value, invitedSupplierIds: Object.freeze([...value.invitedSupplierIds]), responses: Object.freeze(value.responses.map((entry) => Object.freeze({ ...entry }))), award: value.award === null ? null : Object.freeze({ ...value.award }) }); }
function ids(values: unknown, maximum: number): readonly string[] { if (!Array.isArray(values) || values.length > maximum || values.some((value) => typeof value !== 'string')) fail('SOURCING_IDS_INVALID'); const validated = values.map((value) => { if (typeof value !== 'string') fail('SOURCING_IDS_INVALID'); id(value, true); return value; }); if (new Set(validated).size !== validated.length) fail('SOURCING_IDS_DUPLICATE'); return Object.freeze([...validated].sort()); }
function id(value: string, ulid = false): void { if (typeof value !== 'string' || !(ulid ? ULID : ID).test(value)) fail('SOURCING_ID_INVALID'); }
function money(value: string): void { if (!MONEY.test(value)) fail('SOURCING_MONEY_INVALID'); }
function digest(value: string): void { if (!DIGEST.test(value)) fail('SOURCING_ELIGIBILITY_DIGEST_INVALID'); }
function version(value: number): void { if (!Number.isSafeInteger(value) || value < 1) fail('SOURCING_SUPPLIER_VERSION_INVALID'); }
function reason(value: string): void { if (!REASON.test(value)) fail('SOURCING_REASON_INVALID'); }
function text(value: string, minimum: number, maximum: number): string { if (typeof value !== 'string') fail('SOURCING_TEXT_INVALID'); const result = value.trim().normalize('NFC'); const hasControl = Array.from(result).some((character) => { const code = character.charCodeAt(0); return code <= 31 || code === 127; }); if (result.length < minimum || result.length > maximum || hasControl) fail('SOURCING_TEXT_INVALID'); return result; }
function iso(value: string): string { const parsed = new Date(value); if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) || Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) fail('SOURCING_TIME_INVALID'); return value; }
function time(value: Date): string { if (!(value instanceof Date) || Number.isNaN(value.getTime())) fail('SOURCING_TIME_INVALID'); return value.toISOString(); }
function exact(value: unknown, keys: readonly string[]): boolean { if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false; const actual = Reflect.ownKeys(value); return actual.length === keys.length && actual.every((key) => typeof key === 'string') && keys.every((key) => Object.hasOwn(value, key)); }
function fail(code: string): never { throw new Error(code); }
