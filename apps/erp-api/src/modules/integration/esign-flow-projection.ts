import type { ESignFlowStatus } from './esign-flow.schema.js';

const TERMINAL_STATUSES = new Set<ESignFlowStatus>([
  'provider_completed', 'completed', 'rejected', 'expired', 'cancelled',
]);

export interface ESignFlowProjection {
  readonly status: ESignFlowStatus;
  readonly providerStatus: number | null;
  readonly reviewRequired: boolean;
  readonly reviewCode: string | null;
  readonly changed: boolean;
}

/** 把eSign 官方事件投影为 ERP 单调状态，未知或冲突值只转复核。 */
export function projectESignFlow(
  current: ESignFlowStatus,
  currentProviderStatus: number | null,
  currentReviewRequired: boolean,
  currentReviewCode: string | null,
  action: 'SIGN_MISSON_COMPLETE' | 'SIGN_FLOW_COMPLETE',
  providerStatus: number | null,
): ESignFlowProjection {
  if (action === 'SIGN_MISSON_COMPLETE') {
    const status = current === 'awaiting_signature' ? 'partial_signed' : current;
    return Object.freeze({
      status, providerStatus: currentProviderStatus,
      reviewRequired: currentReviewRequired, reviewCode: currentReviewCode,
      changed: status !== current,
    });
  }
  const target = mapESignProviderStatus(providerStatus);
  if (target === null) return Object.freeze({
    status: current, providerStatus, reviewRequired: true,
    reviewCode: 'ESIGN_PROVIDER_STATUS_UNKNOWN', changed: true,
  });
  if (current === 'completed') return Object.freeze({
    status: current, providerStatus: currentProviderStatus,
    reviewRequired: target !== 'provider_completed' || currentReviewRequired,
    reviewCode: target === 'provider_completed' ? null : 'ESIGN_TERMINAL_STATUS_CONFLICT',
    changed: target !== 'provider_completed',
  });
  if (TERMINAL_STATUSES.has(current) && current !== target) return Object.freeze({
    status: current, providerStatus: currentProviderStatus, reviewRequired: true,
    reviewCode: 'ESIGN_TERMINAL_STATUS_CONFLICT', changed: true,
  });
  return Object.freeze({
    status: target, providerStatus, reviewRequired: currentReviewRequired,
    reviewCode: currentReviewCode,
    changed: target !== current || providerStatus !== currentProviderStatus,
  });
}

export function mapESignProviderStatus(status: number | null): ESignFlowStatus | null {
  switch (status) {
    case 2: return 'provider_completed';
    case 3: return 'cancelled';
    case 5: return 'expired';
    case 7: return 'rejected';
    default: return null;
  }
}
