import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import type { OrgDeliveryService } from './org-delivery.service.js';
import type { OrgEmployeeProvisioningService } from './org-employee-provisioning.service.js';
import { OrgIntegrationProcessor } from './org-integration.processor.js';
import type { OrgIntegrationJobName } from './org-integration.queue.js';
import type { OrgOutboxRelayService } from './org-outbox-relay.service.js';
import type { OrgReconciliationService } from './org-reconciliation.service.js';

function job(name: OrgIntegrationJobName): Job<Record<string, never>, unknown, OrgIntegrationJobName> {
  return { name } as Job<Record<string, never>, unknown, OrgIntegrationJobName>;
}

describe('OrgIntegrationProcessor', () => {
  it('将 relay、双平台、开户与对账任务路由到对应服务', async () => {
    const relayBatch = vi.fn().mockResolvedValue(2);
    const processBatch = vi.fn().mockResolvedValue(3);
    const processProvisioning = vi.fn().mockResolvedValue(5);
    const runDaily = vi.fn().mockResolvedValue(4);
    const processor = new OrgIntegrationProcessor(
      { relayBatch } as unknown as OrgOutboxRelayService,
      { processBatch } as unknown as OrgDeliveryService,
      { processBatch: processProvisioning } as unknown as OrgEmployeeProvisioningService,
      { runDaily } as unknown as OrgReconciliationService,
    );

    await expect(processor.process(job('relay'))).resolves.toBe(2);
    await expect(processor.process(job('deliver:dingtalk'))).resolves.toBe(3);
    await expect(processor.process(job('deliver:feishu'))).resolves.toBe(3);
    await expect(processor.process(job('provision'))).resolves.toBe(5);
    await expect(processor.process(job('reconcile'))).resolves.toBe(4);
    expect(relayBatch).toHaveBeenCalledWith(expect.stringMatching(/^org-worker-/), 50);
    expect(processBatch).toHaveBeenNthCalledWith(
      1,
      'dingtalk',
      expect.stringMatching(/^org-worker-/),
      25,
    );
    expect(runDaily).toHaveBeenCalledOnce();
    expect(processProvisioning).toHaveBeenCalledWith(expect.stringMatching(/^org-worker-/), 10);
    expect(processBatch).toHaveBeenNthCalledWith(
      2,
      'feishu',
      expect.stringMatching(/^org-worker-/),
      25,
    );
  });
});
