export const ANALYTICS_EXPORT_QUEUE = 'analytics-export';
export const ANALYTICS_GENERATE_EXPORT_JOB = 'analytics.generate-management-dashboard-export';

export interface AnalyticsExportJobData {
  readonly exportId: string;
  readonly tenantId: string;
  readonly requestedBy: string;
}
