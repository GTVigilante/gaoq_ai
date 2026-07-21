import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { OrgPlatformHttpClient } from '../../integration/org-platform-http.client.js';
import { OrgPushError } from '../../integration/org-push.adapter.js';
import {
  ApprovalNotificationAdapter,
  renderApprovalNotificationText,
  type ApprovalNotificationSendResult,
  type SendApprovalNotificationCommand,
} from './approval-notification.adapter.js';

const responseSchema = z.object({
  code: z.number().int(),
  data: z.object({ message_id: z.string().min(1).max(256) }).optional(),
}).passthrough();

/** 飞书应用机器人单聊适配器；uuid 复用通知 ULID，提供平台侧请求去重。 */
@Injectable()
export class FeishuApprovalNotificationAdapter extends ApprovalNotificationAdapter {
  readonly channel = 'feishu' as const;

  constructor(private readonly http: OrgPlatformHttpClient) {
    super();
  }

  override async send(
    command: SendApprovalNotificationCommand,
  ): Promise<ApprovalNotificationSendResult> {
    const response = await this.http.request({
      origin: 'https://open.feishu.cn',
      path: '/open-apis/im/v1/messages',
      method: 'POST',
      headers: { authorization: `Bearer ${command.access.accessToken}` },
      query: { receive_id_type: 'user_id' },
      body: {
        receive_id: command.externalUserId,
        msg_type: 'text',
        content: JSON.stringify({
          text: renderApprovalNotificationText(command.eventType, command.instanceId),
        }),
        uuid: command.notificationId,
      },
    });
    const parsed = responseSchema.safeParse(response.body);
    if (!parsed.success || parsed.data.code !== 0 || parsed.data.data === undefined) {
      throw new OrgPushError(
        'FEISHU_APPROVAL_MESSAGE_RESPONSE_INVALID',
        'retryable',
        '飞书审批通知响应无效',
      );
    }
    return { externalMessageId: parsed.data.data.message_id };
  }
}
