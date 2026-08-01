export const AUDIT_MAINTENANCE_QUEUE = 'audit-maintenance';
export const AUDIT_ANCHOR_JOB = 'anchor-pending' as const;
export const AUDIT_ANCHOR_SCHEDULER_ID = 'audit-maintenance:anchor-pending';
export const AUDIT_ANCHOR_EVERY_MS = 6 * 60 * 60 * 1_000;
export const AUDIT_ANCHOR_BATCH_SIZE = 100;
