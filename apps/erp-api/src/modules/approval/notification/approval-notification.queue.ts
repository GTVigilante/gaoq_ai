export const APPROVAL_NOTIFICATION_QUEUE = 'approval-notification';

export const APPROVAL_NOTIFICATION_JOB_NAMES = [
  'deliver:dingtalk',
  'deliver:feishu',
] as const;

export type ApprovalNotificationJobName = (typeof APPROVAL_NOTIFICATION_JOB_NAMES)[number];
