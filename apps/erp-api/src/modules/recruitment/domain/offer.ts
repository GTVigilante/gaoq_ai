import { RecruitmentDomainError } from './recruitment.errors.js';
import {
  assertRecruitmentCode,
  assertRecruitmentId,
  assertRecruitmentLabel,
  assertRecruitmentTenant,
  assertRecruitmentVersion,
  deepFreezeRecruitment,
  toRecruitmentIso,
} from './recruitment.validation.js';

export type RecruitmentOfferStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'sending'
  | 'sent'
  | 'accepted'
  | 'declined'
  | 'expired'
  | 'cancelled'
  | 'signed';

/** Offer L4 条款；所有金额均为人民币整数分，禁止浮点金额。 */
export interface RecruitmentOfferTerms {
  readonly currency: 'CNY';
  readonly monthlyBaseSalaryMinor: number;
  readonly salaryMonths: number;
  readonly annualVariableTargetMinor: number;
  readonly signingBonusMinor: number;
  readonly proposedStartDate: string;
  readonly probationMonths: number;
  readonly employmentType: string;
  readonly workLocation: string;
  readonly benefitsSummary: string;
}

export interface RecruitmentOffer {
  readonly id: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly candidateId: string;
  readonly positionId: string;
  readonly completedInterviewId: string;
  readonly terms: RecruitmentOfferTerms;
  readonly expiresAt: string;
  readonly retentionExpiresAt: string;
  readonly status: RecruitmentOfferStatus;
  readonly approvalInstanceId: string | null;
  readonly approvalHistoryId: string | null;
  readonly sendRequestId: string | null;
  readonly sentEvidenceId: string | null;
  readonly acceptanceEvidenceId: string | null;
  readonly esignFlowId: string | null;
  readonly signedEvidenceId: string | null;
  readonly version: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function createRecruitmentOffer(
  input: {
    readonly id: string;
    readonly tenantId: string;
    readonly applicationId: string;
    readonly candidateId: string;
    readonly positionId: string;
    readonly completedInterviewId: string;
    readonly terms: RecruitmentOfferTerms;
    readonly expiresAt: Date;
    readonly retentionExpiresAt: Date;
    readonly actorId: string;
  },
  now: Date,
): RecruitmentOffer {
  for (const [field, value] of Object.entries({
    id: input.id,
    tenantId: input.tenantId,
    applicationId: input.applicationId,
    candidateId: input.candidateId,
    positionId: input.positionId,
    completedInterviewId: input.completedInterviewId,
    actorId: input.actorId,
  })) assertRecruitmentId(value, field);
  const occurredAt = toRecruitmentIso(now);
  const expiresAt = toRecruitmentIso(input.expiresAt);
  const retentionExpiresAt = toRecruitmentIso(input.retentionExpiresAt);
  if (input.expiresAt.getTime() <= now.getTime()) throw new RecruitmentDomainError(
    'RECRUITMENT_OFFER_EXPIRY_INVALID', 'Offer 有效期必须晚于创建时间',
  );
  if (input.retentionExpiresAt.getTime() <= input.expiresAt.getTime()) {
    throw new RecruitmentDomainError(
      'RECRUITMENT_OFFER_RETENTION_INVALID', 'Offer 保留期必须晚于有效期',
    );
  }
  return deepFreezeRecruitment({
    id: input.id,
    tenantId: input.tenantId,
    applicationId: input.applicationId,
    candidateId: input.candidateId,
    positionId: input.positionId,
    completedInterviewId: input.completedInterviewId,
    terms: validateRecruitmentOfferTerms(input.terms),
    expiresAt,
    retentionExpiresAt,
    status: 'draft' as const,
    approvalInstanceId: null,
    approvalHistoryId: null,
    sendRequestId: null,
    sentEvidenceId: null,
    acceptanceEvidenceId: null,
    esignFlowId: null,
    signedEvidenceId: null,
    version: 1,
    createdBy: input.actorId,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
}

/** 数据迁移专用：验证 Offer 最终控制快照，历史动作原文保留在 WORM。 */
export function restoreRecruitmentOfferFromMigration(
  input: {
    readonly id: string;
    readonly tenantId: string;
    readonly applicationId: string;
    readonly candidateId: string;
    readonly positionId: string;
    readonly completedInterviewId: string;
    readonly terms: RecruitmentOfferTerms;
    readonly expiresAt: string;
    readonly retentionExpiresAt: string;
    readonly status: RecruitmentOfferStatus;
    readonly approvalInstanceId: string | null;
    readonly approvalHistoryId: string | null;
    readonly sendRequestId: string | null;
    readonly sentEvidenceId: string | null;
    readonly acceptanceEvidenceId: string | null;
    readonly esignFlowId: string | null;
    readonly signedEvidenceId: string | null;
    readonly version: number;
    readonly createdBy: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  },
  now: Date,
): RecruitmentOffer {
  for (const [field, value] of Object.entries({
    id: input.id, tenantId: input.tenantId, applicationId: input.applicationId,
    candidateId: input.candidateId, positionId: input.positionId,
    completedInterviewId: input.completedInterviewId, createdBy: input.createdBy,
  })) assertRecruitmentId(value, field);
  const createdAt = strictOfferMigrationIso(input.createdAt);
  const updatedAt = strictOfferMigrationIso(input.updatedAt);
  const expiresAt = strictOfferMigrationIso(input.expiresAt);
  const retentionExpiresAt = strictOfferMigrationIso(input.retentionExpiresAt);
  if (createdAt > updatedAt || Date.parse(updatedAt) > now.getTime() + 5 * 60 * 1_000 ||
    Date.parse(expiresAt) <= Date.parse(createdAt) ||
    Date.parse(retentionExpiresAt) <= Date.parse(expiresAt) ||
    Date.parse(retentionExpiresAt) <= now.getTime()) throw new RecruitmentDomainError(
    'RECRUITMENT_MIGRATION_OFFER_TIMELINE_INVALID', 'Offer 迁移时间线或保留期无效',
  );
  for (const [field, value] of Object.entries({
    approvalInstanceId: input.approvalInstanceId,
    approvalHistoryId: input.approvalHistoryId,
    sendRequestId: input.sendRequestId,
    sentEvidenceId: input.sentEvidenceId,
    acceptanceEvidenceId: input.acceptanceEvidenceId,
    esignFlowId: input.esignFlowId,
    signedEvidenceId: input.signedEvidenceId,
  })) if (value !== null) assertRecruitmentId(value, field);
  const pending = input.status === 'pending_approval';
  const approvedHistory = !['draft', 'pending_approval'].includes(input.status);
  if (pending !== (input.approvalInstanceId !== null) ||
    approvedHistory !== (input.approvalHistoryId !== null) ||
    (input.approvalInstanceId !== null && input.approvalHistoryId !== null)) {
    throw new RecruitmentDomainError(
      'RECRUITMENT_MIGRATION_OFFER_APPROVAL_INVALID', 'Offer 迁移审批引用与状态不一致',
    );
  }
  const sendRequested = input.sendRequestId !== null;
  const sent = input.sentEvidenceId !== null;
  const decided = input.acceptanceEvidenceId !== null;
  const signed = input.esignFlowId !== null || input.signedEvidenceId !== null;
  if ((sent && !sendRequested) || (decided && !sent) ||
    ((input.esignFlowId === null) !== (input.signedEvidenceId === null)) || (signed && !decided)) {
    throw new RecruitmentDomainError(
      'RECRUITMENT_MIGRATION_OFFER_EVIDENCE_INVALID', 'Offer 迁移外部证据链不完整',
    );
  }
  const exactShape = (
    input.status === 'draft' && !sendRequested && !sent && !decided && !signed
  ) || (
    input.status === 'pending_approval' && !sendRequested && !sent && !decided && !signed
  ) || (
    ['approved', 'rejected'].includes(input.status) && !sendRequested && !sent && !decided && !signed
  ) || (input.status === 'sending' && sendRequested && !sent && !decided && !signed) ||
    (input.status === 'sent' && sendRequested && sent && !decided && !signed) ||
    (['accepted', 'declined'].includes(input.status) && sendRequested && sent && decided && !signed) ||
    (input.status === 'signed' && sendRequested && sent && decided && signed) ||
    (['expired', 'cancelled'].includes(input.status) && !decided && !signed);
  if (!exactShape) throw new RecruitmentDomainError(
    'RECRUITMENT_MIGRATION_OFFER_EVIDENCE_INVALID', 'Offer 迁移状态与证据形状不一致',
  );
  const expectedVersion = 1 + (pending ? 1 : approvedHistory ? 2 : 0) +
    (sendRequested ? 1 : 0) + (sent ? 1 : 0) + (decided ? 1 : 0) + (signed ? 1 : 0) +
    (['expired', 'cancelled'].includes(input.status) ? 1 : 0);
  if (input.version !== expectedVersion) throw new RecruitmentDomainError(
    'RECRUITMENT_MIGRATION_OFFER_VERSION_INVALID', 'Offer 迁移版本与控制动作不一致',
  );
  return deepFreezeRecruitment({
    ...input,
    terms: validateRecruitmentOfferTerms(input.terms),
    createdAt,
    updatedAt,
    expiresAt,
    retentionExpiresAt,
  });
}

export function submitRecruitmentOffer(
  offer: RecruitmentOffer,
  input: {
    readonly tenantId: string;
    readonly expectedVersion: number;
    readonly actorId: string;
    readonly approvalInstanceId: string;
  },
  now: Date,
): RecruitmentOffer {
  assertCommand(offer, input.tenantId, input.expectedVersion);
  assertRecruitmentId(input.actorId, 'actorId');
  assertRecruitmentId(input.approvalInstanceId, 'approvalInstanceId');
  if (offer.status !== 'draft' || offer.createdBy !== input.actorId) {
    throw new RecruitmentDomainError(
      'RECRUITMENT_OFFER_SUBMIT_DENIED', '只有创建人可提交 Offer 草稿',
    );
  }
  assertNotExpired(offer, now);
  return advance(offer, now, {
    status: 'pending_approval', approvalInstanceId: input.approvalInstanceId,
  });
}

export function applyRecruitmentOfferApprovalOutcome(
  offer: RecruitmentOffer,
  input: {
    readonly tenantId: string;
    readonly expectedVersion: number;
    readonly approvalInstanceId: string;
    readonly outcome: 'approved' | 'rejected';
    readonly approvalVerified: boolean;
  },
  now: Date,
): RecruitmentOffer {
  assertCommand(offer, input.tenantId, input.expectedVersion);
  if (
    offer.status !== 'pending_approval' || !input.approvalVerified ||
    offer.approvalInstanceId !== input.approvalInstanceId
  ) throw new RecruitmentDomainError(
    'RECRUITMENT_OFFER_APPROVAL_EVIDENCE_INVALID',
    'Offer 审批结果缺少可信审批证据或引用不匹配',
  );
  if (input.outcome === 'approved') assertNotExpired(offer, now);
  return advance(offer, now, { status: input.outcome });
}

/** 创建发送意图；真正进入 sent 必须等待投递系统回写可信证据。 */
export function requestRecruitmentOfferSend(
  offer: RecruitmentOffer,
  input: {
    readonly tenantId: string;
    readonly expectedVersion: number;
    readonly sendRequestId: string;
  },
  now: Date,
): RecruitmentOffer {
  assertCommand(offer, input.tenantId, input.expectedVersion);
  assertRecruitmentId(input.sendRequestId, 'sendRequestId');
  if (offer.status !== 'approved') throw invalidTransition();
  assertNotExpired(offer, now);
  return advance(offer, now, { status: 'sending', sendRequestId: input.sendRequestId });
}

export function recordRecruitmentOfferSent(
  offer: RecruitmentOffer,
  input: {
    readonly tenantId: string;
    readonly expectedVersion: number;
    readonly sendRequestId: string;
    readonly sentEvidenceId: string;
    readonly deliveryVerified: boolean;
  },
  now: Date,
): RecruitmentOffer {
  assertCommand(offer, input.tenantId, input.expectedVersion);
  assertRecruitmentId(input.sentEvidenceId, 'sentEvidenceId');
  if (
    offer.status !== 'sending' || !input.deliveryVerified ||
    offer.sendRequestId !== input.sendRequestId
  ) throw new RecruitmentDomainError(
    'RECRUITMENT_OFFER_DELIVERY_EVIDENCE_INVALID',
    'Offer 发送缺少可信投递证据或发送请求不匹配',
  );
  assertNotExpired(offer, now);
  return advance(offer, now, { status: 'sent', sentEvidenceId: input.sentEvidenceId });
}

export function recordRecruitmentOfferDecision(
  offer: RecruitmentOffer,
  input: {
    readonly tenantId: string;
    readonly expectedVersion: number;
    readonly decision: 'accepted' | 'declined';
    readonly acceptanceEvidenceId: string;
    readonly candidateEvidenceVerified: boolean;
  },
  now: Date,
): RecruitmentOffer {
  assertCommand(offer, input.tenantId, input.expectedVersion);
  assertRecruitmentId(input.acceptanceEvidenceId, 'acceptanceEvidenceId');
  if (offer.status !== 'sent' || !input.candidateEvidenceVerified) {
    throw new RecruitmentDomainError(
      'RECRUITMENT_OFFER_ACCEPTANCE_EVIDENCE_INVALID',
      'Offer 决定缺少候选人可信身份与接受证据',
    );
  }
  assertNotExpired(offer, now);
  return advance(offer, now, {
    status: input.decision,
    acceptanceEvidenceId: input.acceptanceEvidenceId,
  });
}

export function recordRecruitmentOfferSigned(
  offer: RecruitmentOffer,
  input: {
    readonly tenantId: string;
    readonly expectedVersion: number;
    readonly esignFlowId: string;
    readonly signedEvidenceId: string;
    readonly esignEvidenceVerified: boolean;
  },
  now: Date,
): RecruitmentOffer {
  assertCommand(offer, input.tenantId, input.expectedVersion);
  assertRecruitmentId(input.esignFlowId, 'esignFlowId');
  assertRecruitmentId(input.signedEvidenceId, 'signedEvidenceId');
  if (offer.status !== 'accepted' || !input.esignEvidenceVerified) {
    throw new RecruitmentDomainError(
      'RECRUITMENT_OFFER_ESIGN_EVIDENCE_INVALID', 'Offer 签署缺少可信 eSign 完成证据',
    );
  }
  return advance(offer, now, {
    status: 'signed',
    esignFlowId: input.esignFlowId,
    signedEvidenceId: input.signedEvidenceId,
  });
}

export function expireRecruitmentOffer(
  offer: RecruitmentOffer,
  input: { readonly tenantId: string; readonly expectedVersion: number },
  now: Date,
): RecruitmentOffer {
  assertCommand(offer, input.tenantId, input.expectedVersion);
  if (!['approved', 'sending', 'sent'].includes(offer.status) || now.getTime() < Date.parse(offer.expiresAt)) {
    throw invalidTransition();
  }
  return advance(offer, now, { status: 'expired' });
}

export function validateRecruitmentOfferTerms(
  terms: RecruitmentOfferTerms,
): RecruitmentOfferTerms {
  if (terms.currency !== 'CNY') throw new RecruitmentDomainError(
    'RECRUITMENT_OFFER_CURRENCY_INVALID', '当前 Offer 币种只允许 ISO 4217 CNY',
  );
  for (const [field, amount] of Object.entries({
    monthlyBaseSalaryMinor: terms.monthlyBaseSalaryMinor,
    annualVariableTargetMinor: terms.annualVariableTargetMinor,
    signingBonusMinor: terms.signingBonusMinor,
  })) {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new RecruitmentDomainError(
      'RECRUITMENT_OFFER_AMOUNT_INVALID', `${field} 必须为非负安全整数分`,
    );
  }
  if (terms.monthlyBaseSalaryMinor < 1) throw new RecruitmentDomainError(
    'RECRUITMENT_OFFER_AMOUNT_INVALID', '月基本工资必须为正整数分',
  );
  if (!Number.isSafeInteger(terms.salaryMonths) || terms.salaryMonths < 1 || terms.salaryMonths > 24) {
    throw new RecruitmentDomainError(
      'RECRUITMENT_OFFER_SALARY_MONTHS_INVALID', '计薪月数必须为 1..24 的整数',
    );
  }
  if (
    !Number.isSafeInteger(terms.probationMonths) ||
    terms.probationMonths < 0 || terms.probationMonths > 12
  ) throw new RecruitmentDomainError(
    'RECRUITMENT_OFFER_PROBATION_INVALID', '试用期月数必须为 0..12 的整数',
  );
  if (!/^\d{4}-\d{2}-\d{2}$/.test(terms.proposedStartDate) ||
    Number.isNaN(Date.parse(`${terms.proposedStartDate}T00:00:00.000Z`))) {
    throw new RecruitmentDomainError(
      'RECRUITMENT_OFFER_START_DATE_INVALID', '预计入职日期必须为有效 YYYY-MM-DD',
    );
  }
  assertRecruitmentCode(terms.employmentType, 'employmentType');
  assertRecruitmentLabel(terms.workLocation, 'workLocation', 256);
  assertRecruitmentLabel(terms.benefitsSummary, 'benefitsSummary', 4_096);
  return deepFreezeRecruitment({
    ...terms,
    workLocation: terms.workLocation.trim(),
    benefitsSummary: terms.benefitsSummary.trim(),
  });
}

function assertCommand(
  offer: RecruitmentOffer,
  tenantId: string,
  expectedVersion: number,
): void {
  assertRecruitmentTenant(offer.tenantId, tenantId);
  assertRecruitmentVersion(expectedVersion);
  if (offer.version !== expectedVersion) throw new RecruitmentDomainError(
    'RECRUITMENT_VERSION_CONFLICT', 'Offer 版本冲突',
  );
}

function assertNotExpired(offer: RecruitmentOffer, now: Date): void {
  if (now.getTime() >= Date.parse(offer.expiresAt)) throw new RecruitmentDomainError(
    'RECRUITMENT_OFFER_EXPIRED', 'Offer 已超过有效期',
  );
}

function advance<T extends Partial<RecruitmentOffer>>(
  offer: RecruitmentOffer,
  now: Date,
  patch: T,
): RecruitmentOffer {
  return deepFreezeRecruitment({
    ...offer,
    ...patch,
    version: offer.version + 1,
    updatedAt: toRecruitmentIso(now),
  });
}

function invalidTransition(): RecruitmentDomainError {
  return new RecruitmentDomainError(
    'RECRUITMENT_OFFER_TRANSITION_INVALID', 'Offer 状态迁移无效',
  );
}

function strictOfferMigrationIso(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new RecruitmentDomainError(
      'RECRUITMENT_MIGRATION_OFFER_TIMELINE_INVALID', 'Offer 迁移时间必须为严格 UTC ISO',
    );
  }
  return value;
}
