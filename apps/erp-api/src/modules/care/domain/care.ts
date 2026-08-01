export class CareDomainError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CareDomainError';
  }
}

export type SeparationType =
  | 'voluntary_resignation'
  | 'involuntary_termination'
  | 'retirement'
  | 'contract_end';

export type CareTaskCode =
  | 'handover_accepted'
  | 'assets_cleared'
  | 'finance_cleared'
  | 'data_retention_confirmed';

export type CareCaseStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'clearing'
  | 'ready'
  | 'scheduled'
  | 'executing'
  | 'completed'
  | 'cancelled';

export interface CareCase {
  readonly id: string;
  readonly tenantId: string;
  readonly employeeId: string;
  readonly employmentId: string;
  readonly separationType: SeparationType;
  readonly reasonCode: string;
  readonly lastWorkingDate: string;
  readonly tenantTimeZone: string;
  readonly accessDisableAt: string;
  readonly status: CareCaseStatus;
  readonly approvalInstanceId: string | null;
  readonly handoverEvidenceId: string | null;
  readonly assetsEvidenceId: string | null;
  readonly financeEvidenceId: string | null;
  readonly retentionEvidenceId: string | null;
  readonly executionEvidenceId: string | null;
  readonly orgTerminationEvidenceId: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CareTaskEvidence {
  readonly id: string;
  readonly tenantId: string;
  readonly careCaseId: string;
  readonly taskCode: CareTaskCode;
  readonly evidenceId: string;
  readonly actorId: string;
  readonly occurredAt: string;
}

export interface AlumniConsent {
  readonly id: string;
  readonly tenantId: string;
  readonly personId: string;
  readonly careCaseId: string;
  readonly purpose: 'alumni_network' | 'rehire_contact' | 'alumni_events';
  readonly channels: readonly ('email' | 'sms' | 'phone' | 'wechat')[];
  readonly consentVersion: string;
  readonly consentEvidenceId: string;
  readonly grantedAt: string;
  readonly expiresAt: string;
  readonly withdrawnAt: string | null;
  readonly expiredAt: string | null;
  readonly status: 'active' | 'withdrawn' | 'expired';
  readonly version: number;
}

export function createOffboardingCase(input: {
  readonly id: string;
  readonly tenantId: string;
  readonly employeeId: string;
  readonly employmentId: string;
  readonly separationType: SeparationType;
  readonly reasonCode: string;
  readonly lastWorkingDate: string;
  readonly tenantTimeZone: string;
  readonly accessDisableAt: string;
}, now: Date): CareCase {
  assertIds(input, ['id', 'tenantId', 'employeeId', 'employmentId']);
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(input.reasonCode)) invalid(
    'CARE_REASON_CODE_INVALID', '离职原因必须使用受控编码',
  );
  const lastWorkingDate = localDate(input.lastWorkingDate, 'lastWorkingDate');
  const accessDisableAt = isoDate(input.accessDisableAt, 'accessDisableAt');
  assertTimeZone(input.tenantTimeZone);
  if (dateInTimeZone(new Date(accessDisableAt), input.tenantTimeZone) !== lastWorkingDate) invalid(
    'CARE_ACCESS_DATE_MISMATCH', '权限失效时间必须落在租户时区的最后工作日',
  );
  const nowTime = now.getTime();
  const disableTime = Date.parse(accessDisableAt);
  if (disableTime < nowTime - 366 * DAY || disableTime > nowTime + 730 * DAY) invalid(
    'CARE_ACCESS_TIME_OUT_OF_RANGE', '权限失效时间超出允许范围',
  );
  const occurredAt = now.toISOString();
  return Object.freeze({
    ...input, lastWorkingDate, accessDisableAt, status: 'draft', approvalInstanceId: null,
    handoverEvidenceId: null, assetsEvidenceId: null, financeEvidenceId: null,
    retentionEvidenceId: null, executionEvidenceId: null, orgTerminationEvidenceId: null,
    version: 1, createdAt: occurredAt, updatedAt: occurredAt,
  });
}

export function submitCareCaseForApproval(
  careCase: CareCase,
  input: { readonly tenantId: string; readonly expectedVersion: number; readonly approvalInstanceId: string },
  now: Date,
): CareCase {
  assertCommand(careCase, input.tenantId, input.expectedVersion);
  assertId(input.approvalInstanceId, 'approvalInstanceId');
  if (careCase.status !== 'draft') invalid('CARE_SUBMIT_INVALID', '只有草稿可以提交审批');
  return next(careCase, now, { status: 'pending_approval', approvalInstanceId: input.approvalInstanceId });
}

export function approveCareCase(
  careCase: CareCase,
  input: { readonly tenantId: string; readonly expectedVersion: number; readonly approvalVerified: boolean },
  now: Date,
): CareCase {
  assertCommand(careCase, input.tenantId, input.expectedVersion);
  if (careCase.status !== 'pending_approval' || !input.approvalVerified) invalid(
    'CARE_APPROVAL_UNVERIFIED', '离职审批未由受信任审批服务确认',
  );
  return next(careCase, now, { status: 'approved' });
}

export function rejectCareCase(
  careCase: CareCase,
  input: { readonly tenantId: string; readonly expectedVersion: number; readonly rejectionVerified: boolean },
  now: Date,
): CareCase {
  assertCommand(careCase, input.tenantId, input.expectedVersion);
  if (careCase.status !== 'pending_approval' || !input.rejectionVerified) invalid(
    'CARE_REJECTION_UNVERIFIED', '离职审批拒绝未由受信任审批服务确认',
  );
  return next(careCase, now, { status: 'cancelled' });
}

export function recordCareTaskEvidence(
  careCase: CareCase,
  input: {
    readonly tenantId: string;
    readonly expectedVersion: number;
    readonly taskCode: CareTaskCode;
    readonly evidenceId: string;
    readonly evidenceRecordId: string;
    readonly actorId: string;
  },
  now: Date,
): { readonly careCase: CareCase; readonly evidence: CareTaskEvidence | null } {
  assertCommand(careCase, input.tenantId, input.expectedVersion);
  if (!['approved', 'clearing'].includes(careCase.status)) invalid(
    'CARE_TASKS_LOCKED', '当前离职状态禁止登记清算证据',
  );
  assertIds(input, ['evidenceId', 'evidenceRecordId', 'actorId']);
  const current = evidenceFor(careCase, input.taskCode);
  if (current !== null) {
    if (current === input.evidenceId) return { careCase, evidence: null };
    invalid('CARE_TASK_EVIDENCE_IMMUTABLE', '清算证据已存在且不可替换');
  }
  const changed = withEvidence(careCase, input.taskCode, input.evidenceId);
  const ready = allTasksComplete(changed);
  const updated = next(changed, now, { status: ready ? 'ready' : 'clearing' });
  return Object.freeze({
    careCase: updated,
    evidence: Object.freeze({
      id: input.evidenceRecordId, tenantId: careCase.tenantId, careCaseId: careCase.id,
      taskCode: input.taskCode, evidenceId: input.evidenceId, actorId: input.actorId,
      occurredAt: now.toISOString(),
    }),
  });
}

export function scheduleCareExecution(
  careCase: CareCase,
  input: { readonly tenantId: string; readonly expectedVersion: number },
  now: Date,
): CareCase {
  assertCommand(careCase, input.tenantId, input.expectedVersion);
  if (careCase.status !== 'ready') invalid('CARE_NOT_READY', '离职清算任务尚未全部完成');
  return next(careCase, now, { status: 'scheduled' });
}

export function beginCareExecution(
  careCase: CareCase,
  input: {
    readonly tenantId: string;
    readonly expectedVersion: number;
    readonly executionEvidenceId: string;
  },
  now: Date,
): CareCase {
  assertCommand(careCase, input.tenantId, input.expectedVersion);
  assertId(input.executionEvidenceId, 'executionEvidenceId');
  if (careCase.status !== 'scheduled') invalid('CARE_EXECUTION_INVALID', '离职案件尚未排期执行');
  if (now.getTime() < Date.parse(careCase.accessDisableAt)) invalid(
    'CARE_EXECUTION_TOO_EARLY', '未到权限失效时间，禁止提前执行离职',
  );
  return next(careCase, now, { status: 'executing', executionEvidenceId: input.executionEvidenceId });
}

export function completeCareExecution(
  careCase: CareCase,
  input: {
    readonly tenantId: string;
    readonly expectedVersion: number;
    readonly orgTerminationEvidenceId: string;
    readonly orgTerminationVerified: boolean;
  },
  now: Date,
): CareCase {
  assertCommand(careCase, input.tenantId, input.expectedVersion);
  assertId(input.orgTerminationEvidenceId, 'orgTerminationEvidenceId');
  if (careCase.status !== 'executing' || !input.orgTerminationVerified) invalid(
    'CARE_ORG_TERMINATION_UNVERIFIED', '组织域尚未确认劳动关系关闭与身份吊销',
  );
  return next(careCase, now, {
    status: 'completed', orgTerminationEvidenceId: input.orgTerminationEvidenceId,
  });
}

export function createAlumniConsent(input: {
  readonly id: string;
  readonly tenantId: string;
  readonly personId: string;
  readonly careCaseId: string;
  readonly purpose: AlumniConsent['purpose'];
  readonly channels: AlumniConsent['channels'];
  readonly consentVersion: string;
  readonly consentEvidenceId: string;
  readonly grantedAt: string;
  readonly expiresAt: string;
  readonly careCompletedVerified: boolean;
}): AlumniConsent {
  assertIds(input, ['id', 'tenantId', 'personId', 'careCaseId', 'consentEvidenceId']);
  if (!input.careCompletedVerified) invalid(
    'CARE_ALUMNI_CASE_INCOMPLETE', '只有已完成离职案件才能建立校友授权',
  );
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(input.consentVersion)) invalid(
    'CARE_CONSENT_VERSION_INVALID', '校友授权版本非法',
  );
  const channels = Object.freeze([...new Set(input.channels)].sort());
  if (channels.length === 0) invalid('CARE_CONSENT_CHANNEL_REQUIRED', '至少选择一个联系渠道');
  const grantedAt = isoDate(input.grantedAt, 'grantedAt');
  const expiresAt = isoDate(input.expiresAt, 'expiresAt');
  const lifetime = Date.parse(expiresAt) - Date.parse(grantedAt);
  if (lifetime <= 0 || lifetime > 5 * 366 * DAY) invalid(
    'CARE_CONSENT_EXPIRY_INVALID', '校友授权有效期必须大于零且不超过五年',
  );
  return Object.freeze({
    id: input.id, tenantId: input.tenantId, personId: input.personId,
    careCaseId: input.careCaseId, purpose: input.purpose, channels,
    consentVersion: input.consentVersion, consentEvidenceId: input.consentEvidenceId,
    grantedAt, expiresAt,
    withdrawnAt: null, expiredAt: null, status: 'active', version: 1,
  });
}

export function withdrawAlumniConsent(
  consent: AlumniConsent,
  input: { readonly tenantId: string; readonly expectedVersion: number },
  now: Date,
): AlumniConsent {
  if (consent.tenantId !== input.tenantId) invalid('CARE_CROSS_TENANT', '禁止跨租户操作校友授权');
  if (consent.version !== input.expectedVersion) invalid('CARE_VERSION_CONFLICT', '校友授权版本冲突');
  if (consent.status === 'withdrawn') return consent;
  if (consent.status === 'expired') invalid(
    'CARE_CONSENT_ALREADY_EXPIRED', '已到期授权不能再撤回',
  );
  return Object.freeze({
    ...consent, status: 'withdrawn', withdrawnAt: now.toISOString(),
    version: consent.version + 1,
  });
}

export function expireAlumniConsent(
  consent: AlumniConsent,
  input: { readonly tenantId: string; readonly expectedVersion: number },
  now: Date,
): AlumniConsent {
  if (consent.tenantId !== input.tenantId) invalid('CARE_CROSS_TENANT', '禁止跨租户操作校友授权');
  if (consent.version !== input.expectedVersion) invalid('CARE_VERSION_CONFLICT', '校友授权版本冲突');
  if (consent.status === 'expired' || consent.status === 'withdrawn') return consent;
  if (now.getTime() < Date.parse(consent.expiresAt)) invalid(
    'CARE_CONSENT_EXPIRY_TOO_EARLY', '未到授权失效时间，禁止提前终止',
  );
  return Object.freeze({
    ...consent, status: 'expired', expiredAt: now.toISOString(),
    version: consent.version + 1,
  });
}

export function careTaskStatuses(
  careCase: CareCase,
): Readonly<Record<CareTaskCode, 'pending' | 'completed'>> {
  return Object.freeze({
    handover_accepted: careCase.handoverEvidenceId === null ? 'pending' : 'completed',
    assets_cleared: careCase.assetsEvidenceId === null ? 'pending' : 'completed',
    finance_cleared: careCase.financeEvidenceId === null ? 'pending' : 'completed',
    data_retention_confirmed: careCase.retentionEvidenceId === null ? 'pending' : 'completed',
  });
}

const DAY = 24 * 60 * 60 * 1_000;

function next(
  careCase: CareCase,
  now: Date,
  patch: Partial<CareCase>,
): CareCase {
  return Object.freeze({
    ...careCase, ...patch, version: careCase.version + 1, updatedAt: now.toISOString(),
  });
}

function assertCommand(careCase: CareCase, tenantId: string, expectedVersion: number): void {
  assertId(tenantId, 'tenantId');
  if (careCase.tenantId !== tenantId) invalid('CARE_CROSS_TENANT', '禁止跨租户操作离职案件');
  if (careCase.version !== expectedVersion) invalid('CARE_VERSION_CONFLICT', '离职案件版本冲突');
  if (careCase.status === 'completed' || careCase.status === 'cancelled') invalid(
    'CARE_CASE_TERMINAL', '终态离职案件不可修改',
  );
}

function withEvidence(careCase: CareCase, code: CareTaskCode, evidenceId: string): CareCase {
  if (code === 'handover_accepted') return { ...careCase, handoverEvidenceId: evidenceId };
  if (code === 'assets_cleared') return { ...careCase, assetsEvidenceId: evidenceId };
  if (code === 'finance_cleared') return { ...careCase, financeEvidenceId: evidenceId };
  return { ...careCase, retentionEvidenceId: evidenceId };
}

function evidenceFor(careCase: CareCase, code: CareTaskCode): string | null {
  if (code === 'handover_accepted') return careCase.handoverEvidenceId;
  if (code === 'assets_cleared') return careCase.assetsEvidenceId;
  if (code === 'finance_cleared') return careCase.financeEvidenceId;
  return careCase.retentionEvidenceId;
}

function allTasksComplete(careCase: CareCase): boolean {
  return Object.values(careTaskStatuses(careCase)).every((status) => status === 'completed');
}

function assertIds(value: object, fields: readonly string[]): void {
  const record = value as Readonly<Record<string, unknown>>;
  for (const field of fields) assertId(record[field], field);
}

function assertId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) invalid(
    'CARE_ID_INVALID', `${field} 非法`,
  );
}

function localDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid('CARE_LOCAL_DATE_INVALID', `${field} 非法`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) invalid(
    'CARE_LOCAL_DATE_INVALID', `${field} 非法`,
  );
  return value;
}

function isoDate(value: string, field: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) invalid(
    'CARE_INSTANT_INVALID', `${field} 必须为规范 UTC 时间`,
  );
  return value;
}

function assertTimeZone(value: string): void {
  if (value.length < 1 || value.length > 64) invalid('CARE_TIME_ZONE_INVALID', '租户时区非法');
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value }).format(new Date());
  } catch {
    invalid('CARE_TIME_ZONE_INVALID', '租户时区非法');
  }
}

function dateInTimeZone(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function invalid(code: string, message: string): never {
  throw new CareDomainError(code, message);
}
