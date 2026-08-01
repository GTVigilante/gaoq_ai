export const MARKETING_AUTOMATION_QUEUE = 'marketing-automation';
export interface MarketingPublishJob {
  readonly sideEffectEventId: string;
  readonly tenantId: string;
  readonly contentId: string;
  readonly aggregateVersion: number;
}
