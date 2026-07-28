import { z } from 'zod';

import type { ESignFlowStatus } from './esign-flow.schema.js';

const TERMINAL_STATUSES = new Set<ESignFlowStatus>([
  'provider_completed', 'completed', 'rejected', 'expired', 'cancelled',
]);
const flowStatusSchema = z.enum([
  'awaiting_signature',
  'partial_signed',
  'provider_completed',
  'completed',
  'rejected',
  'expired',
  'cancelled',
]);
const projectionInputSchema = z.object({
  current: flowStatusSchema,
  currentProviderStatus: z.number().int().min(0).max(99).nullable(),
  currentReviewRequired: z.boolean(),
  currentReviewCode: z.string().regex(/^[A-Z0-9_]{3,128}$/).nullable(),
  action: z.enum(['SIGN_MISSON_COMPLETE', 'SIGN_FLOW_COMPLETE']),
  providerStatus: z.number().int().min(0).max(99).nullable(),
}).strict().refine(
  (value) => {
    if (
      value.currentReviewRequired !== (value.currentReviewCode !== null)
    ) return false;
    if (!TERMINAL_STATUSES.has(value.current)) return true;
    const currentTarget = mapESignProviderStatus(value.currentProviderStatus);
    return value.current === 'completed'
      ? currentTarget === 'provider_completed'
      : currentTarget === value.current;
  },
);

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
  const input = projectionInputSchema.safeParse({
    current,
    currentProviderStatus,
    currentReviewRequired,
    currentReviewCode,
    action,
    providerStatus,
  });
  if (!input.success) throw new Error('ESIGN_FLOW_PROJECTION_INPUT_INVALID');
  if (input.data.action === 'SIGN_MISSON_COMPLETE') {
    return projection(input.data, {
      status: input.data.current === 'awaiting_signature'
        ? 'partial_signed'
        : input.data.current,
      providerStatus: input.data.currentProviderStatus,
      reviewRequired: input.data.currentReviewRequired,
      reviewCode: input.data.currentReviewCode,
    });
  }
  const target = mapESignProviderStatus(input.data.providerStatus);
  if (target === null) return projection(input.data, {
    status: input.data.current,
    providerStatus: TERMINAL_STATUSES.has(input.data.current)
      ? input.data.currentProviderStatus
      : input.data.providerStatus,
    reviewRequired: true,
    reviewCode: 'ESIGN_PROVIDER_STATUS_UNKNOWN',
  });
  if (input.data.current === 'completed') {
    return target === 'provider_completed'
      ? projection(input.data, {
          status: input.data.current,
          providerStatus: input.data.providerStatus,
          reviewRequired: input.data.currentReviewRequired,
          reviewCode: input.data.currentReviewCode,
        })
      : projection(input.data, {
          status: input.data.current,
          providerStatus: input.data.currentProviderStatus,
          reviewRequired: true,
          reviewCode: 'ESIGN_TERMINAL_STATUS_CONFLICT',
        });
  }
  if (
    TERMINAL_STATUSES.has(input.data.current) &&
    input.data.current !== target
  ) return projection(input.data, {
    status: input.data.current,
    providerStatus: input.data.currentProviderStatus,
    reviewRequired: true,
    reviewCode: 'ESIGN_TERMINAL_STATUS_CONFLICT',
  });
  return projection(input.data, {
    status: target,
    providerStatus: input.data.providerStatus,
    reviewRequired: input.data.currentReviewRequired,
    reviewCode: input.data.currentReviewCode,
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

function projection(
  current: z.infer<typeof projectionInputSchema>,
  next: Omit<ESignFlowProjection, 'changed'>,
): ESignFlowProjection {
  return Object.freeze({
    ...next,
    changed:
      next.status !== current.current ||
      next.providerStatus !== current.currentProviderStatus ||
      next.reviewRequired !== current.currentReviewRequired ||
      next.reviewCode !== current.currentReviewCode,
  });
}
