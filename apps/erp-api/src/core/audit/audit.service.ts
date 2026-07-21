import { Injectable } from '@nestjs/common';

import { TenantContextService } from '../tenant/tenant-context.service.js';
import { AuditEventSink, type AuditRecordInput } from './audit.types.js';

const AUDIT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export type SystemAuditRecordInput = AuditRecordInput & { readonly traceId: string };

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

  /** 仅供可信后台任务记录系统审计；调用方必须显式提供租户和不可复用 traceId。 */
  async recordSystem(tenantId: string, input: SystemAuditRecordInput): Promise<void> {
    if (!AUDIT_ID_PATTERN.test(tenantId) || !AUDIT_ID_PATTERN.test(input.traceId)) {
      throw new Error('系统审计上下文非法');
    }
    const { traceId, ...record } = input;
    await this.sink.append({
      ...record,
      tenantId,
      actorId: 'system:integration-worker',
      actorType: 'system_job',
      traceId,
      occurredAt: new Date().toISOString(),
    });
  }
}
