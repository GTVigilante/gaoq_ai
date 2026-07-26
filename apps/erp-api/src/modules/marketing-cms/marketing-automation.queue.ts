export const MARKETING_AUTOMATION_QUEUE = 'marketing-automation';
export interface MarketingPublishJob {
  readonly tenantId: string;
  readonly contentId: string;
}
