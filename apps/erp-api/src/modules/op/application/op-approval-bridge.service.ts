import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { z } from 'zod';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  OpApprovalBridgeRecord,
  type OpApprovalBridgeDocument,
} from '../persistence/op.schemas.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EXTERNAL_EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const SOURCE_DOCUMENT_TYPE_PATTERN = /^[a-z][a-z0-9._-]{1,63}$/;
const TEMPLATE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const bridgeProjectionSchema = z.object({
  tenantId: z.string().regex(ID_PATTERN),
  externalEventId: z.string().regex(EXTERNAL_EVENT_ID_PATTERN),
  sourceDocumentType: z.string().regex(SOURCE_DOCUMENT_TYPE_PATTERN),
  sourceDocumentId: z.string().regex(ID_PATTERN),
  approvalInstanceId: z.string().regex(ULID_PATTERN),
  templateCode: z.string().regex(TEMPLATE_CODE_PATTERN),
  approvalStatus: z.enum([
    'processing',
    'running',
    'approved',
    'rejected',
    'withdrawn',
  ]),
  approvalVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  completedAt: z.date().nullable(),
  updatedAt: z.date(),
}).strict().refine((value) => {
  if (value.updatedAt.getTime() > Date.now()) return false;
  if (value.approvalStatus === 'processing') {
    return value.approvalVersion === 0 && value.completedAt === null;
  }
  if (value.approvalStatus === 'running') {
    return value.approvalVersion >= 2 && value.completedAt === null;
  }
  return value.approvalVersion >= 3 &&
    value.completedAt !== null &&
    value.completedAt.getTime() <= value.updatedAt.getTime();
});
const BRIDGE_PROJECTION = Object.freeze({
  tenantId: 1,
  externalEventId: 1,
  sourceDocumentType: 1,
  sourceDocumentId: 1,
  approvalInstanceId: 1,
  templateCode: 1,
  approvalStatus: 1,
  approvalVersion: 1,
  completedAt: 1,
  updatedAt: 1,
  _id: 0,
} as const);

export interface OpApprovalBridgeView {
  readonly externalEventId: string;
  readonly sourceDocumentType: string;
  readonly sourceDocumentId: string;
  readonly approvalInstanceId: string;
  readonly templateCode: string;
  readonly approvalStatus: 'processing' | 'running' | 'approved' | 'rejected' | 'withdrawn';
  readonly approvalVersion: number;
  readonly completedAt: string | null;
  readonly updatedAt: string;
}

/** OP 审批桥只读查询；不返回表单、Inbox、签名或投递内部字段。 */
@Injectable()
export class OpApprovalBridgeService {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(OpApprovalBridgeRecord.name)
    private readonly records: Model<OpApprovalBridgeDocument>,
  ) {}

  async get(externalEventId: string): Promise<OpApprovalBridgeView> {
    const trusted = this.context.getRequired();
    if (!trusted.actor.scopes.includes('erp:op:approval_bridge:read')) {
      throw new ForbiddenException({
        code: 'OP_APPROVAL_BRIDGE_SCOPE_REQUIRED',
        message: '缺少 OP 审批桥读取权限',
      });
    }
    if (!EXTERNAL_EVENT_ID_PATTERN.test(externalEventId)) {
      throw new BadRequestException({
        code: 'OP_APPROVAL_EVENT_ID_INVALID', message: 'OP 审批事件标识无效',
      });
    }
    const tenantId = trusted.tenant.tenantId;
    const record = await this.records.findOne(
      { tenantId, externalEventId },
      BRIDGE_PROJECTION,
    ).lean().exec();
    if (record === null) throw new NotFoundException({
      code: 'OP_APPROVAL_BRIDGE_NOT_FOUND', message: 'OP 审批关联不存在',
    });
    const parsed = bridgeProjectionSchema.safeParse(record);
    if (
      !parsed.success ||
      parsed.data.tenantId !== tenantId ||
      parsed.data.externalEventId !== externalEventId
    ) throw new Error('OP_APPROVAL_BRIDGE_STATE_INVALID');
    const bridge = parsed.data;
    return Object.freeze({
      externalEventId: bridge.externalEventId,
      sourceDocumentType: bridge.sourceDocumentType,
      sourceDocumentId: bridge.sourceDocumentId,
      approvalInstanceId: bridge.approvalInstanceId,
      templateCode: bridge.templateCode,
      approvalStatus: bridge.approvalStatus,
      approvalVersion: bridge.approvalVersion,
      completedAt: bridge.completedAt?.toISOString() ?? null,
      updatedAt: bridge.updatedAt.toISOString(),
    });
  }
}
