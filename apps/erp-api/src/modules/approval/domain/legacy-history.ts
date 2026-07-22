import { ApprovalDomainError } from './approval.errors.js';
import {
  assertApprovalCode,
  assertApprovalId,
  assertPositiveVersion,
  toApprovalIso,
} from './approval.validation.js';

const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MIGRATION_EVIDENCE_REF_PATTERN =
  /^erp:\/\/data-migrations\/runs\/[0-7][0-9A-HJKMNP-TV-Z]{25}\/attachments\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type LegacyApprovalOutcome = 'approved' | 'rejected' | 'withdrawn';

/**
 * 旧系统已终结审批的最小不可变历史。
 * 表单、标题、意见和动作正文只保留在 WORM 迁移证据中，不进入在线审批集合。
 */
export interface ApprovalLegacyHistory {
  readonly id: string;
  readonly tenantId: string;
  readonly templateId: string;
  readonly templateCode: string;
  readonly templateRevision: number;
  readonly initiatorEmployeeId: string;
  readonly outcome: LegacyApprovalOutcome;
  readonly completedAt: string;
  readonly archivedAt: string | null;
  readonly migrationEvidenceRef: string;
  readonly evidenceChecksum: string;
  readonly version: 1;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type CreateApprovalLegacyHistoryInput = Omit<
  ApprovalLegacyHistory,
  'id' | 'tenantId' | 'version' | 'createdAt' | 'updatedAt'
> & {
  readonly id: string;
  readonly tenantId: string;
};

/** 创建旧审批历史；只接受最小检索元数据和不可变证据引用。 */
export function createApprovalLegacyHistory(
  input: CreateApprovalLegacyHistoryInput,
  now: Date,
): ApprovalLegacyHistory {
  assertApprovalId(input.id, 'id');
  assertApprovalId(input.tenantId, 'tenantId');
  assertApprovalId(input.templateId, 'templateId');
  assertApprovalId(input.initiatorEmployeeId, 'initiatorEmployeeId');
  assertApprovalCode(input.templateCode, 'templateCode');
  assertPositiveVersion(input.templateRevision, 'templateRevision');
  if (!['approved', 'rejected', 'withdrawn'].includes(input.outcome)) {
    throw new ApprovalDomainError(
      'APPROVAL_HISTORY_OUTCOME_INVALID',
      '旧审批历史结果必须为通过、拒绝或撤回',
    );
  }
  const completedAt = strictIso(input.completedAt, 'completedAt');
  const archivedAt = input.archivedAt === null ? null : strictIso(input.archivedAt, 'archivedAt');
  if (archivedAt !== null && Date.parse(archivedAt) < Date.parse(completedAt)) {
    throw new ApprovalDomainError(
      'APPROVAL_HISTORY_ARCHIVE_TIME_INVALID',
      '旧审批历史归档时间不能早于完成时间',
    );
  }
  if (!MIGRATION_EVIDENCE_REF_PATTERN.test(input.migrationEvidenceRef)) {
    throw new ApprovalDomainError(
      'APPROVAL_HISTORY_EVIDENCE_REF_INVALID',
      '旧审批历史必须引用当前迁移运行的附件账本',
    );
  }
  if (!HASH_PATTERN.test(input.evidenceChecksum)) {
    throw new ApprovalDomainError(
      'APPROVAL_HISTORY_EVIDENCE_HASH_INVALID',
      '旧审批历史证据校验和无效',
    );
  }
  const occurredAt = toApprovalIso(now);
  return Object.freeze({
    ...input,
    completedAt,
    archivedAt,
    version: 1,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
}

/** 从持久化边界恢复并重新执行全部历史完整性约束。 */
export function restoreApprovalLegacyHistory(
  value: ApprovalLegacyHistory,
): ApprovalLegacyHistory {
  const createdAt = strictIso(value.createdAt, 'createdAt');
  const restored = createApprovalLegacyHistory({
    id: value.id,
    tenantId: value.tenantId,
    templateId: value.templateId,
    templateCode: value.templateCode,
    templateRevision: value.templateRevision,
    initiatorEmployeeId: value.initiatorEmployeeId,
    outcome: value.outcome,
    completedAt: value.completedAt,
    archivedAt: value.archivedAt,
    migrationEvidenceRef: value.migrationEvidenceRef,
    evidenceChecksum: value.evidenceChecksum,
  }, new Date(createdAt));
  if (value.version !== 1 || strictIso(value.updatedAt, 'updatedAt') !== createdAt) {
    throw new ApprovalDomainError(
      'APPROVAL_HISTORY_INTEGRITY_INVALID',
      '旧审批历史持久化事实已被修改',
    );
  }
  return restored;
}

function strictIso(value: string, field: string): string {
  const parsed = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new ApprovalDomainError(
      'APPROVAL_HISTORY_DATE_INVALID',
      `${field} 必须为规范 UTC ISO 时间`,
    );
  }
  return value;
}
