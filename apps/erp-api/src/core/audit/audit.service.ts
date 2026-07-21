import { Injectable } from '@nestjs/common';

import { TenantContextService } from '../tenant/tenant-context.service.js';
import { AuditEventSink, type AuditRecordInput } from './audit.types.js';

const AUDIT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export type SystemAuditRecordInput = AuditRecordInput & { readonly traceId: string };
export type TrustedUserAuditRecordInput = AuditRecordInput & {
  readonly actorId: string;
  readonly traceId: string;
};
export type TrustedServiceAuditRecordInput = AuditRecordInput & {
  readonly actorId: string;
  readonly traceId: string;
};

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

  /** 公共协议端点完成独立身份校验后，以显式可信用户上下文记录审计。 */
  async recordTrustedUser(tenantId: string, input: TrustedUserAuditRecordInput): Promise<void> {
    if (
      !AUDIT_ID_PATTERN.test(tenantId) ||
      !AUDIT_ID_PATTERN.test(input.actorId) ||
      !AUDIT_ID_PATTERN.test(input.traceId)
    ) throw new Error('可信用户审计上下文非法');
    const { actorId, traceId, ...record } = input;
    await this.sink.append({
      ...record,
      tenantId,
      actorId,
      actorType: 'user',
      traceId,
      occurredAt: new Date().toISOString(),
    });
  }

  /** 公共协议端点完成客户端认证后，以显式可信服务身份记录审计。 */
  async recordTrustedService(
    tenantId: string,
    input: TrustedServiceAuditRecordInput,
  ): Promise<void> {
    if (
      !AUDIT_ID_PATTERN.test(tenantId) ||
      !AUDIT_ID_PATTERN.test(input.actorId) ||
      !AUDIT_ID_PATTERN.test(input.traceId)
    ) throw new Error('可信服务审计上下文非法');
    const { actorId, traceId, ...record } = input;
    await this.sink.append({
      ...record,
      tenantId,
      actorId,
      actorType: 'mcp_client',
      traceId,
      occurredAt: new Date().toISOString(),
    });
  }

  /** 公共集成端点完成独立协议验签后，以外部服务身份记录审计。 */
  async recordTrustedExternalService(
    tenantId: string,
    input: TrustedServiceAuditRecordInput,
  ): Promise<void> {
    if (
      !AUDIT_ID_PATTERN.test(tenantId) ||
      !AUDIT_ID_PATTERN.test(input.actorId) ||
      !AUDIT_ID_PATTERN.test(input.traceId)
    ) throw new Error('可信外部服务审计上下文非法');
    const { actorId, traceId, ...record } = input;
    await this.sink.append({
      ...record,
      tenantId,
      actorId,
      actorType: 'service',
      traceId,
      occurredAt: new Date().toISOString(),
    });
  }
}
