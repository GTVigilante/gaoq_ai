import {
  payrollDigest,
  type PayrollCalculationResult,
} from './payroll-calculation.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const REASON = /^[A-Z][A-Z0-9_]{1,63}$/;

export type PayrollAdjustmentType = 'supplement' | 'reversal' | 'tax_only';
export type PayrollAdjustmentStatus =
  | 'prepared'
  | 'pending_approval'
  | 'approved'
  | 'locked'
  | 'settled'
  | 'cancelled';

export interface PayrollAdjustmentControl {
  readonly id: string;
  readonly tenantId: string;
  readonly status: PayrollAdjustmentStatus;
  readonly preparedBy: string;
  readonly requestedBy: string | null;
  readonly approvalInstanceId: string | null;
  readonly approvalDecidedBy: string | null;
  readonly approvalEvidenceId: string | null;
  readonly lockedBy: string | null;
  readonly strongAuthEvidenceId: string | null;
  readonly version: number;
}

export interface PayrollAdjustmentInput {
  readonly tenantId: string;
  readonly employeeId: string;
  readonly period: string;
  readonly originalCalculationLineId: string;
  readonly reasonCode: string;
  readonly originalPeriodStatus:
    | 'locked'
    | 'disbursing'
    | 'reconciling'
    | 'reconciled';
  readonly original: PayrollCalculationResult;
  readonly corrected: PayrollCalculationResult;
}

export interface PayrollAdjustmentDelta {
  readonly grossPayMinor: number;
  readonly taxableEarningsMinor: number;
  readonly withholdingTaxMinor: number;
  readonly netPayMinor: number;
  readonly cumulativeAfter: PayrollAdjustmentCumulativeDelta;
}

export interface PayrollAdjustmentCumulativeDelta {
  readonly taxableIncomeMinor: number;
  readonly basicDeductionMinor: number;
  readonly socialInsuranceMinor: number;
  readonly housingFundMinor: number;
  readonly specialAdditionalDeductionMinor: number;
  readonly otherDeductionMinor: number;
  readonly taxWithheldMinor: number;
}

export interface PayrollAdjustmentResult {
  readonly type: PayrollAdjustmentType;
  readonly currency: 'CNY';
  readonly originalCalculationLineId: string;
  readonly originalInputHash: string;
  readonly originalResultHash: string;
  readonly correctedInputHash: string;
  readonly correctedResultHash: string;
  readonly reasonCode: string;
  readonly delta: PayrollAdjustmentDelta;
  /** 仅正向现金差额可进入补发支付链。 */
  readonly payableMinor: number;
  /** 负向现金差额只能进入独立扣回/应收链，绝不生成负数银行指令。 */
  readonly receivableMinor: number;
  readonly adjustmentHash: string;
}

export class PayrollAdjustmentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PayrollAdjustmentError';
  }
}

/**
 * 将确定性工资差额绑定到专用审批实例。
 * 请求人必须是独立人工主体，审批正文只引用调整标识与摘要。
 */
export function requestPayrollAdjustmentApproval(
  control: PayrollAdjustmentControl,
  command: {
    readonly tenantId: string;
    readonly expectedVersion: number;
    readonly requestedBy: string;
    readonly approvalInstanceId: string;
  },
): PayrollAdjustmentControl {
  assertControlCommand(control, command);
  requireControlStatus(control, ['prepared']);
  assertId(command.requestedBy, 'requestedBy');
  assertId(command.approvalInstanceId, 'approvalInstanceId');
  if (command.requestedBy === control.preparedBy) {
    invalid('PAYROLL_ADJUSTMENT_REQUESTER_INDEPENDENCE_REQUIRED', '调整送审人与重算服务必须分离');
  }
  return nextControl(control, {
    status: 'pending_approval',
    requestedBy: command.requestedBy,
    approvalInstanceId: command.approvalInstanceId,
  });
}

/** 只接受专用 Approval 模板形成的可信终态，并强制送审人与审批人分离。 */
export function applyPayrollAdjustmentApproval(
  control: PayrollAdjustmentControl,
  command: {
    readonly tenantId: string;
    readonly expectedVersion: number;
    readonly approvalInstanceId: string;
    readonly outcome: 'approved' | 'rejected';
    readonly decidedBy: string;
    readonly approvalEvidenceId: string;
    readonly trustedApproval: boolean;
  },
): PayrollAdjustmentControl {
  assertControlCommand(control, command);
  requireControlStatus(control, ['pending_approval']);
  assertId(command.approvalInstanceId, 'approvalInstanceId');
  assertId(command.decidedBy, 'decidedBy');
  assertId(command.approvalEvidenceId, 'approvalEvidenceId');
  if (!command.trustedApproval || command.approvalInstanceId !== control.approvalInstanceId) {
    invalid('PAYROLL_ADJUSTMENT_APPROVAL_UNTRUSTED', '工资调整审批事实不可信或引用不匹配');
  }
  if (command.decidedBy === control.preparedBy || command.decidedBy === control.requestedBy) {
    invalid('PAYROLL_ADJUSTMENT_APPROVER_INDEPENDENCE_REQUIRED', '调整审批人必须独立于重算与送审人员');
  }
  return nextControl(control, {
    status: command.outcome === 'approved' ? 'approved' : 'cancelled',
    approvalDecidedBy: command.decidedBy,
    approvalEvidenceId: command.approvalEvidenceId,
  });
}

/** R3 锁定必须引用近期 WebAuthn UV，锁定人独立于重算、送审和审批控制链。 */
export function lockPayrollAdjustment(
  control: PayrollAdjustmentControl,
  command: {
    readonly tenantId: string;
    readonly expectedVersion: number;
    readonly lockedBy: string;
    readonly strongAuthEvidenceId: string;
  },
): PayrollAdjustmentControl {
  assertControlCommand(control, command);
  requireControlStatus(control, ['approved']);
  assertId(command.lockedBy, 'lockedBy');
  assertId(command.strongAuthEvidenceId, 'strongAuthEvidenceId');
  if (
    command.lockedBy === control.preparedBy ||
    command.lockedBy === control.requestedBy ||
    command.lockedBy === control.approvalDecidedBy
  ) {
    invalid('PAYROLL_ADJUSTMENT_LOCKER_INDEPENDENCE_REQUIRED', '调整锁定人必须独立于前序控制人员');
  }
  return nextControl(control, {
    status: 'locked',
    lockedBy: command.lockedBy,
    strongAuthEvidenceId: command.strongAuthEvidenceId,
  });
}

/**
 * 从已锁定原结果与服务端重算结果生成不可变差额。
 * 本函数不接收客户端金额，也不执行代发、扣款或税务重报。
 */
export function createPayrollAdjustment(input: PayrollAdjustmentInput): PayrollAdjustmentResult {
  assertInput(input);
  assertResultIntegrity(input.original, 'ORIGINAL');
  assertResultIntegrity(input.corrected, 'CORRECTED');
  if (input.original.inputHash === input.corrected.inputHash) {
    invalid('PAYROLL_ADJUSTMENT_INPUT_UNCHANGED', '更正输入与原输入相同，不得创建调整');
  }
  const delta: PayrollAdjustmentDelta = Object.freeze({
    grossPayMinor: difference(
      input.corrected.grossPayMinor, input.original.grossPayMinor,
    ),
    taxableEarningsMinor: difference(
      input.corrected.taxableEarningsMinor, input.original.taxableEarningsMinor,
    ),
    withholdingTaxMinor: difference(
      input.corrected.withholdingTaxMinor, input.original.withholdingTaxMinor,
    ),
    netPayMinor: difference(
      input.corrected.netPayMinor, input.original.netPayMinor,
    ),
    cumulativeAfter: Object.freeze({
      taxableIncomeMinor: difference(
        input.corrected.cumulativeAfter.taxableIncomeMinor,
        input.original.cumulativeAfter.taxableIncomeMinor,
      ),
      basicDeductionMinor: difference(
        input.corrected.cumulativeAfter.basicDeductionMinor,
        input.original.cumulativeAfter.basicDeductionMinor,
      ),
      socialInsuranceMinor: difference(
        input.corrected.cumulativeAfter.socialInsuranceMinor,
        input.original.cumulativeAfter.socialInsuranceMinor,
      ),
      housingFundMinor: difference(
        input.corrected.cumulativeAfter.housingFundMinor,
        input.original.cumulativeAfter.housingFundMinor,
      ),
      specialAdditionalDeductionMinor: difference(
        input.corrected.cumulativeAfter.specialAdditionalDeductionMinor,
        input.original.cumulativeAfter.specialAdditionalDeductionMinor,
      ),
      otherDeductionMinor: difference(
        input.corrected.cumulativeAfter.otherDeductionMinor,
        input.original.cumulativeAfter.otherDeductionMinor,
      ),
      taxWithheldMinor: difference(
        input.corrected.cumulativeAfter.taxWithheldMinor,
        input.original.cumulativeAfter.taxWithheldMinor,
      ),
    }),
  });
  if (
    delta.grossPayMinor === 0 &&
    delta.taxableEarningsMinor === 0 &&
    delta.withholdingTaxMinor === 0 &&
    delta.netPayMinor === 0 &&
    Object.values(delta.cumulativeAfter).every((item) => item === 0)
  ) {
    invalid('PAYROLL_ADJUSTMENT_DELTA_ZERO', '服务端重算未形成任何工资或税务差额');
  }
  const type: PayrollAdjustmentType = delta.netPayMinor > 0
    ? 'supplement'
    : delta.netPayMinor < 0 ? 'reversal' : 'tax_only';
  const withoutHash = Object.freeze({
    type,
    currency: 'CNY' as const,
    originalCalculationLineId: input.originalCalculationLineId,
    originalInputHash: input.original.inputHash,
    originalResultHash: input.original.resultHash,
    correctedInputHash: input.corrected.inputHash,
    correctedResultHash: input.corrected.resultHash,
    reasonCode: input.reasonCode,
    delta,
    payableMinor: delta.netPayMinor > 0 ? delta.netPayMinor : 0,
    receivableMinor: delta.netPayMinor < 0 ? -delta.netPayMinor : 0,
  });
  return Object.freeze({
    ...withoutHash,
    adjustmentHash: payrollDigest({
      tenantId: input.tenantId, employeeId: input.employeeId,
      period: input.period, ...withoutHash,
    }),
  });
}

function assertInput(input: PayrollAdjustmentInput): void {
  if (!ID.test(input.tenantId) || !ID.test(input.employeeId) ||
    !MONTH.test(input.period) || !ULID.test(input.originalCalculationLineId) ||
    !REASON.test(input.reasonCode) ||
    !['locked', 'disbursing', 'reconciling', 'reconciled'].includes(input.originalPeriodStatus)) {
    invalid('PAYROLL_ADJUSTMENT_REFERENCE_INVALID', '工资调整引用、原因或原周期状态非法');
  }
}

function assertControlCommand(
  control: PayrollAdjustmentControl,
  command: { readonly tenantId: string; readonly expectedVersion: number },
): void {
  if (command.tenantId !== control.tenantId) {
    invalid('PAYROLL_ADJUSTMENT_TENANT_MISMATCH', '工资调整租户不匹配');
  }
  if (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion !== control.version) {
    invalid('PAYROLL_ADJUSTMENT_VERSION_CONFLICT', '工资调整版本冲突');
  }
}

function requireControlStatus(
  control: PayrollAdjustmentControl,
  allowed: readonly PayrollAdjustmentStatus[],
): void {
  if (!allowed.includes(control.status)) {
    invalid('PAYROLL_ADJUSTMENT_TRANSITION_INVALID', '工资调整状态迁移无效');
  }
}

function nextControl(
  control: PayrollAdjustmentControl,
  changes: Partial<PayrollAdjustmentControl>,
): PayrollAdjustmentControl {
  return Object.freeze({
    ...control,
    ...changes,
    id: control.id,
    tenantId: control.tenantId,
    preparedBy: control.preparedBy,
    version: control.version + 1,
  });
}

function assertId(value: string, field: string): void {
  if (!ID.test(value)) invalid('PAYROLL_ADJUSTMENT_CONTROL_ID_INVALID', `${field} 标识非法`);
}

function assertResultIntegrity(
  result: PayrollCalculationResult,
  side: 'ORIGINAL' | 'CORRECTED',
): void {
  const {
    resultHash,
    ...withoutHash
  } = result;
  if (!HASH.test(result.inputHash) || !HASH.test(resultHash) ||
    payrollDigest(withoutHash) !== resultHash) {
    invalid(`PAYROLL_ADJUSTMENT_${side}_INTEGRITY_FAILED`, `${side} 工资结果摘要不一致`);
  }
}

function difference(corrected: number, original: number): number {
  if (!Number.isSafeInteger(corrected) || !Number.isSafeInteger(original)) {
    invalid('PAYROLL_ADJUSTMENT_AMOUNT_INVALID', '工资调整金额必须为安全整数分');
  }
  const value = BigInt(corrected) - BigInt(original);
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    invalid('PAYROLL_ADJUSTMENT_AMOUNT_OVERFLOW', '工资调整差额超出安全整数范围');
  }
  return Number(value);
}

function invalid(code: string, message: string): never {
  throw new PayrollAdjustmentError(code, message);
}
