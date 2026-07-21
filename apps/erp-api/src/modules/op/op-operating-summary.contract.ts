import { createHash } from 'node:crypto';

import { z } from 'zod';

export const OP_OPERATING_SUMMARY_EVENT_TYPE = 'operating.summary.published' as const;
export const OP_OPERATING_SUMMARY_SCHEMA_VERSION = '1.0' as const;
export const OP_MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

const amountMinor = z.number().int().safe().min(0).max(9_000_000_000_000_000);
const count = z.number().int().safe().min(0).max(9_000_000_000_000_000);

/** OP 每日经营摘要唯一允许的指标白名单；禁止动态指标键进入 Mongo 查询或事件。 */
export const opOperatingSummaryEnvelopeSchema = z.object({
  schemaVersion: z.literal(OP_OPERATING_SUMMARY_SCHEMA_VERSION),
  type: z.literal(OP_OPERATING_SUMMARY_EVENT_TYPE),
  occurredAt: z.string().datetime({ offset: true }),
  data: z.object({
    summaryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    revision: z.number().int().safe().min(1).max(1_000_000),
    currency: z.literal('CNY'),
    metrics: z.object({
      gmvMinor: amountMinor,
      paidOrderCount: count,
      refundMinor: amountMinor,
      refundOrderCount: count,
      activeCustomerCount: count,
    }).strict(),
  }).strict(),
}).strict();

export type OpOperatingSummaryEnvelope = z.infer<typeof opOperatingSummaryEnvelopeSchema>;

/** 对原始字节计算稳定摘要，供 Inbox、修订记录与事件证据链关联。 */
export function hashOpPayload(rawBody: Buffer): string {
  return createHash('sha256').update(rawBody).digest('base64url');
}
