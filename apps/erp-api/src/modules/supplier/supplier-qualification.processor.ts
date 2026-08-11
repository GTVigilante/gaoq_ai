import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

import { AuditService } from '../../core/audit/audit.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import { SupplierService } from './application/supplier.service.js';
import { SupplierQualificationScanRepository } from './persistence/supplier-qualification-scan.repository.js';
import {
  SUPPLIER_QUALIFICATION_QUEUE,
  SUPPLIER_QUALIFICATION_SCAN_JOB,
  type SupplierQualificationScanJobData,
} from './supplier-qualification.queue.js';

@Processor(SUPPLIER_QUALIFICATION_QUEUE, { concurrency: 1 })
export class SupplierQualificationProcessor extends WorkerHost {
  private readonly logger = new Logger(SupplierQualificationProcessor.name);

  constructor(
    private readonly context: TenantContextService,
    private readonly scan: SupplierQualificationScanRepository,
    private readonly suppliers: SupplierService,
    private readonly audit: AuditService,
  ) { super(); }

  override async process(job: Job<SupplierQualificationScanJobData>): Promise<number> {
    if (job.name !== SUPPLIER_QUALIFICATION_SCAN_JOB || Reflect.ownKeys(job.data).length !== 0) {
      throw new Error('SUPPLIER_QUALIFICATION_SCAN_JOB_INVALID');
    }
    const now = new Date();
    const scanDay = now.toISOString().slice(0, 10);
    const warning = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 30))
      .toISOString().slice(0, 10);
    let after: { readonly tenantId: string; readonly supplierId: string } | null = null;
    let processed = 0;
    for (let page = 0; page < 100; page += 1) {
      const candidates = await this.scan.listCandidates(warning, after);
      for (const candidate of candidates) {
        await this.review(candidate, scanDay, String(job.id));
        processed += 1;
      }
      const last = candidates.at(-1);
      if (last === undefined || candidates.length < 200) break;
      after = { tenantId: last.tenantId, supplierId: last.supplierId };
    }
    return processed;
  }

  private async review(
    candidate: { readonly tenantId: string; readonly supplierId: string; readonly version: number },
    scanDay: string,
    traceId: string,
  ): Promise<void> {
    await this.context.run({
      tenant: { tenantId: candidate.tenantId, source: 'service_identity' },
      actor: {
        actorId: 'system:supplier-qualification', actorType: 'system_job', tenantId: candidate.tenantId,
        roleCodes: ['SUPPLIER_QUALIFICATION_WORKER'], scopes: ['erp:supplier:qualification:review'],
        departmentIds: [], traceId,
      },
    }, async () => {
      const result = await this.suppliers.reviewQualificationExpiry(
        candidate.supplierId,
        candidate.version,
        scanDay,
        `supplier-qualification-${scanDay}-${candidate.supplierId}`,
      );
      if (result.outcome === 'skipped') return;
      try {
        await this.audit.record({
          action: `supplier.qualification.${result.outcome}`,
          resourceType: 'supplier_relationship', resourceId: result.supplierId,
          riskLevel: result.outcome === 'expired' ? 'R2' : 'R1', outcome: 'success',
          metadata: { version: result.version, scanDay },
        });
      } catch {
        this.logger.error({ code: 'SUPPLIER_QUALIFICATION_COMMITTED_AUDIT_FAILED', resourceId: result.supplierId });
      }
    });
  }
}
