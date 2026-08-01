import { createHash } from 'node:crypto';

export const ANALYTICS_EXPORT_QUEUE = 'analytics-export';
export const ANALYTICS_GENERATE_EXPORT_JOB = 'analytics.generate-management-dashboard-export';

export interface AnalyticsExportJobData {
  readonly exportId: string;
  readonly tenantId: string;
  readonly requestedBy: string;
  readonly generation: number;
}

/** 绑定租户、所有者、导出标识与生成代次，避免全局 BullMQ JobId 碰撞和旧任务重放。 */
export function createAnalyticsExportJobId(data: AnalyticsExportJobData): string {
  const digest = createHash('sha256')
    .update(data.tenantId, 'utf8').update('\0')
    .update(data.requestedBy, 'utf8').update('\0')
    .update(data.exportId, 'utf8').update('\0')
    .update(String(data.generation), 'utf8')
    .digest('base64url');
  return `analytics_export_${digest}`;
}
