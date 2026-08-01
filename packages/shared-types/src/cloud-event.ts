/**
 * CloudEvents 1.0 基础信封。
 *
 * 按规范将 `tenantId`、`traceId`、`idempotencyKey` 作为顶层扩展属性，
 * 所有领域事件与出入站集成事件统一使用该信封。
 *
 * @see https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md
 */
export interface CloudEvent<TData = unknown> {
  /** CloudEvents 规范版本，固定为 "1.0"。 */
  readonly specversion: '1.0';
  /** 事件唯一标识，同一事件重投时保持不变。 */
  readonly id: string;
  /** 事件来源，URI 引用形式，例如 "/payroll/cycles"。 */
  readonly source: string;
  /** 事件类型，反向域名形式，例如 "os.gaoq.payroll.cycle.locked"。 */
  readonly type: string;
  /** 事件发生时间，UTC ISO 8601 字符串。 */
  readonly time?: string;
  /** 数据载荷的媒体类型。 */
  readonly datacontenttype?: 'application/json';
  /** 事件主题，通常为聚合根标识。 */
  readonly subject?: string;
  /** 业务数据载荷。 */
  readonly data?: TData;
  /** 扩展属性：事件所属租户。 */
  readonly tenantId: string;
  /** 扩展属性：调用链追踪标识。 */
  readonly traceId: string;
  /** 扩展属性：幂等键，消费端必须据此去重。 */
  readonly idempotencyKey: string;
}
