import type { ActorType, RiskLevel } from '@gaoq/shared-types';

/** 可持久化审计事件；不得记录密码、令牌和原始敏感载荷。 */
export interface AuditEvent {
  readonly tenantId: string;
  readonly actorId: string;
  readonly actorType: ActorType;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string;
  readonly riskLevel: RiskLevel;
  readonly outcome: 'success' | 'denied' | 'failure';
  readonly occurredAt: string;
  readonly traceId: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

/** 业务模块提交的审计参数；身份和追踪字段由可信上下文补齐。 */
export type AuditRecordInput = Omit<
  AuditEvent,
  'tenantId' | 'actorId' | 'actorType' | 'occurredAt' | 'traceId'
>;

/** 审计事件输出端口，后续可替换为不可篡改存储。 */
export abstract class AuditEventSink {
  abstract append(event: AuditEvent): Promise<void>;
}
