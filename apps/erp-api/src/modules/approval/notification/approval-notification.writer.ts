import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession, Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  currentApprovalNode,
  type ApprovalAction,
  type ApprovalInstance,
} from '../domain/instance.js';
import {
  ApprovalNotificationRecord,
  type ApprovalNotificationDocument,
} from './approval-notification.schema.js';

const CHANNELS = ['dingtalk', 'feishu'] as const;

/** 在审批事务内生成双通道通知意图；实际平台发送完全异步。 */
@Injectable()
export class ApprovalNotificationWriter {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(ApprovalNotificationRecord.name)
    private readonly records: Model<ApprovalNotificationDocument>,
  ) {}

  async append(
    instance: ApprovalInstance,
    action: ApprovalAction,
    session: ClientSession,
  ): Promise<number> {
    const tenantId = this.context.getTenantRequired().tenantId;
    if (tenantId !== instance.tenantId) throw new Error('审批通知拒绝跨租户聚合');
    const recipients = notificationRecipients(instance, action);
    if (recipients.length === 0) return 0;
    const now = new Date(action.occurredAt);
    const documents = recipients.flatMap((recipientActorId) => CHANNELS.map((channel) => ({
      notificationId: createEventId(now),
      tenantId,
      instanceId: instance.id,
      aggregateVersion: instance.version,
      eventType: action.type,
      recipientActorId,
      channel,
      riskLevel: instance.templateSnapshot.riskLevel,
      status: 'pending' as const,
      attempts: 0,
      nextAttemptAt: now,
      lockedAt: null,
      lockedBy: null,
      externalMessageId: null,
      lastErrorCode: null,
      sentAt: null,
    })));
    await this.records.create(documents, { session });
    return documents.length;
  }
}

function notificationRecipients(
  instance: ApprovalInstance,
  action: ApprovalAction,
): readonly string[] {
  switch (action.type) {
    case 'instance.submitted':
    case 'instance.decided': {
      if (instance.status !== 'running') return [instance.initiatorId];
      const node = currentApprovalNode(instance);
      if (node === null) return [];
      const completedActors = new Set(node.decisions.map((decision) => decision.principalApproverId));
      return node.actorIds.filter((actorId) => !completedActors.has(actorId));
    }
    case 'instance.approver_transferred':
      return [action.toApproverId];
    case 'instance.approver_added':
      return [action.approverId];
    case 'instance.withdrawn':
      return [instance.initiatorId];
    case 'instance.archived':
      return [];
  }
}
