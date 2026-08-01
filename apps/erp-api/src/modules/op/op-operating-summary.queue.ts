export const OP_OPERATING_SUMMARY_QUEUE = 'op-operating-summary';
export const OP_PROCESS_OPERATING_SUMMARY_JOB = 'op.process-operating-summary';

export interface OpOperatingSummaryJobData {
  readonly tenantId: string;
  readonly inboxId: string;
}
