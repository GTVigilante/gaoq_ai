import { createHash } from 'node:crypto';

import { z } from 'zod';

export const OP_APPROVAL_REQUEST_EVENT_TYPE = 'approval.requested' as const;
export const OP_APPROVAL_SCHEMA_VERSION = '1.0' as const;
export const OP_MAX_APPROVAL_BODY_BYTES = 1024 * 1024;

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const sourceType = z.string().min(2).max(64).regex(/^[a-z][a-z0-9._-]{1,63}$/);
const fieldKey = z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const scalar = z.union([
  z.string().max(10_000), z.number().finite().safe(), z.boolean(), z.null(),
]);
const formValue = z.union([scalar, z.array(scalar).max(200)]);
const formData = z.record(fieldKey, formValue).superRefine((value, context) => {
  if (Object.keys(value).length > 100) {
    context.addIssue({ code: 'custom', message: '审批表单字段不得超过 100 个' });
  }
});

/** OP 只提交来源单据与表单；模板由 ERP 路由绑定决定，禁止请求选择模板。 */
export const opApprovalRequestEnvelopeSchema = z.object({
  schemaVersion: z.literal(OP_APPROVAL_SCHEMA_VERSION),
  type: z.literal(OP_APPROVAL_REQUEST_EVENT_TYPE),
  occurredAt: z.string().datetime({ offset: true }),
  data: z.object({
    sourceDocumentType: sourceType,
    sourceDocumentId: identifier,
    initiatorEmployeeId: identifier,
    title: z.string().trim().min(1).max(256),
    formData,
  }).strict(),
}).strict();

export type OpApprovalRequestEnvelope = z.infer<typeof opApprovalRequestEnvelopeSchema>;

export function hashOpApprovalPayload(rawBody: Buffer): string {
  return createHash('sha256').update(rawBody).digest('base64url');
}
