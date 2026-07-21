import { describe, expect, it } from 'vitest';

import { MetricsService } from './metrics.service.js';

describe('MetricsService', () => {
  it('输出标准 Prometheus 文本并记录 HTTP 与审计指标', async () => {
    const metrics = new MetricsService();
    metrics.recordHttpRequest({
      method: 'GET', controller: 'HealthController', handler: 'live',
      statusCode: 200, durationSeconds: 0.01,
    });
    metrics.recordAuditAppend('success', 0.02);
    metrics.recordAuditTransactionRetry();
    metrics.recordAuditVerification('failure', 0.03);
    metrics.recordAuditWormExport('success', new Date('2026-07-21T06:00:00.000Z'));
    metrics.setQueueJobs('org-integration', { waiting: 2, active: 1, delayed: 3, failed: 4 });
    metrics.recordQueueMetricsPollFailure('org-integration');

    const output = await metrics.render();
    expect(metrics.contentType).toContain('text/plain');
    expect(output).toContain('gaoq_http_requests_total');
    expect(output).toContain('controller="HealthController"');
    expect(output).toContain('gaoq_audit_append_total{outcome="success"} 1');
    expect(output).toContain('gaoq_audit_transaction_retries_total 1');
    expect(output).toContain('gaoq_audit_verification_total{outcome="failure"} 1');
    expect(output).toContain('gaoq_audit_worm_exports_total{outcome="success"} 1');
    expect(output).toContain('gaoq_audit_worm_last_success_timestamp_seconds 1784613600');
    expect(output).toContain('gaoq_queue_jobs{queue="org-integration",state="failed"} 4');
    expect(output).toContain('gaoq_queue_metrics_poll_failures_total{queue="org-integration"} 1');
    expect(output).not.toContain('tenant_id');
    expect(output).not.toContain('user_id');
  });
});
