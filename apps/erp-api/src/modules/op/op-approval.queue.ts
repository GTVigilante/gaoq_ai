export const OP_APPROVAL_BRIDGE_QUEUE = 'op-approval-bridge';
export const OP_PROCESS_APPROVAL_REQUEST_JOB = 'op.process-approval-request';
export const OP_RELAY_APPROVAL_RESULT_JOB = 'op.relay-approval-result';
export const OP_DELIVER_APPROVAL_RESULT_JOB = 'op.deliver-approval-result';

export type OpApprovalBridgeJobName =
  | typeof OP_PROCESS_APPROVAL_REQUEST_JOB
  | typeof OP_RELAY_APPROVAL_RESULT_JOB
  | typeof OP_DELIVER_APPROVAL_RESULT_JOB;

export interface OpApprovalRequestJobData {
  readonly tenantId: string;
  readonly inboxId: string;
}

export type OpApprovalBridgeJobData = OpApprovalRequestJobData | Record<string, never>;
