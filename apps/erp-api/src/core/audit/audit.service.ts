import { Injectable } from '@nestjs/common';

import { TenantContextService } from '../tenant/tenant-context.service.js';
import { AuditEventSink, type AuditRecordInput } from './audit.types.js';

@Injectable()
export class AuditService {
  constructor(
    private readonly sink: AuditEventSink,
    private readonly context: TenantContextService,
  ) {}

  /** 通过统一端口记录审计事件，业务模块不得绕过此服务直接写日志。 */
  async record(input: AuditRecordInput): Promise<void> {
    const { tenant, actor } = this.context.getRequired();
    await this.sink.append({
      ...input,
      tenantId: tenant.tenantId,
      actorId: actor.actorId,
      actorType: actor.actorType,
      traceId: actor.traceId,
      occurredAt: new Date().toISOString(),
    });
  }
}
