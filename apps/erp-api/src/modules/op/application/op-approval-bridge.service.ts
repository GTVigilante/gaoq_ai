import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  OpApprovalBridgeRecord,
  type OpApprovalBridgeDocument,
} from '../persistence/op.schemas.js';

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
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(externalEventId)) {
      throw new BadRequestException({
        code: 'OP_APPROVAL_EVENT_ID_INVALID', message: 'OP 审批事件标识无效',
      });
    }
    const tenantId = this.context.getTenantRequired().tenantId;
    const record = await this.records.findOne(
      { tenantId, externalEventId },
      {
        externalEventId: 1, sourceDocumentType: 1, sourceDocumentId: 1,
        approvalInstanceId: 1, templateCode: 1, approvalStatus: 1,
        approvalVersion: 1, completedAt: 1, updatedAt: 1, _id: 0,
      },
    ).lean().exec();
    if (record === null) throw new NotFoundException({
      code: 'OP_APPROVAL_BRIDGE_NOT_FOUND', message: 'OP 审批关联不存在',
    });
    return Object.freeze({
      externalEventId: record.externalEventId,
      sourceDocumentType: record.sourceDocumentType,
      sourceDocumentId: record.sourceDocumentId,
      approvalInstanceId: record.approvalInstanceId,
      templateCode: record.templateCode,
      approvalStatus: record.approvalStatus,
      approvalVersion: record.approvalVersion,
      completedAt: record.completedAt?.toISOString() ?? null,
      updatedAt: record.updatedAt.toISOString(),
    });
  }
}
