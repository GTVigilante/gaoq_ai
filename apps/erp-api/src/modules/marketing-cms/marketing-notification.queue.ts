export const MARKETING_NOTIFICATION_QUEUE = 'marketing-notification';
export type MarketingNotificationChannel = 'email' | 'feishu';
export interface MarketingNotificationJob {
  readonly sideEffectEventId: string;
  readonly tenantId: string;
  readonly leadId: string;
  readonly aggregateVersion: number;
  readonly channel: MarketingNotificationChannel;
}
