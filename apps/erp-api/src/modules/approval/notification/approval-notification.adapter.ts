import type { OrgPlatformAccess } from '../../integration/org-platform-token.service.js';
import type { ApprovalNotificationChannel } from './approval-notification.schema.js';

export interface SendApprovalNotificationCommand {
  readonly tenantId: string;
  readonly notificationId: string;
  readonly instanceId: string;
  readonly eventType: string;
  readonly externalUserId: string;
  /** 仅在 Worker 内存中传递，禁止写入记录、日志、异常消息或审计元数据。 */
  readonly access: OrgPlatformAccess;
}

export interface ApprovalNotificationSendResult {
  readonly externalMessageId: string;
}

/** 平台通知适配器只接收最小发送命令，禁止读取审批数据库或表单。 */
export abstract class ApprovalNotificationAdapter {
  abstract readonly channel: ApprovalNotificationChannel;
  abstract send(command: SendApprovalNotificationCommand): Promise<ApprovalNotificationSendResult>;
}

export const DINGTALK_APPROVAL_NOTIFICATION_ADAPTER = Symbol(
  'DINGTALK_APPROVAL_NOTIFICATION_ADAPTER',
);
export const FEISHU_APPROVAL_NOTIFICATION_ADAPTER = Symbol(
  'FEISHU_APPROVAL_NOTIFICATION_ADAPTER',
);

export class ApprovalNotificationAdapterRegistry {
  private readonly adapters: ReadonlyMap<ApprovalNotificationChannel, ApprovalNotificationAdapter>;

  constructor(dingtalk: ApprovalNotificationAdapter, feishu: ApprovalNotificationAdapter) {
    if (dingtalk.channel !== 'dingtalk' || feishu.channel !== 'feishu') {
      throw new Error('审批通知适配器渠道装配错误');
    }
    this.adapters = new Map([
      ['dingtalk', dingtalk],
      ['feishu', feishu],
    ]);
  }

  get(channel: ApprovalNotificationChannel): ApprovalNotificationAdapter {
    const adapter = this.adapters.get(channel);
    if (adapter === undefined) throw new Error('审批通知适配器未装配');
    return adapter;
  }
}

/** 固定模板仅包含动作类别和 ERP 内部编号，绝不拼接标题、表单或人员信息。 */
export function renderApprovalNotificationText(eventType: string, instanceId: string): string {
  const pending = eventType === 'instance.submitted' ||
    eventType === 'instance.approver_transferred' ||
    eventType === 'instance.approver_added';
  return pending
    ? `你有一项审批待处理。请登录 ERP 审批工作台查看。编号：${instanceId}`
    : `一项审批状态已更新。请登录 ERP 审批工作台查看。编号：${instanceId}`;
}
