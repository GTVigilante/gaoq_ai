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

const responseSchema = z.object({ processQueryKey: z.string().min(1).max(256) }).passthrough();

/** 钉钉企业机器人单聊适配器；robotCode 使用非密钥 clientId。 */
@Injectable()
export class DingTalkApprovalNotificationAdapter extends ApprovalNotificationAdapter {
  readonly channel = 'dingtalk' as const;

  constructor(private readonly http: OrgPlatformHttpClient) {
    super();
  }

  override async send(
    command: SendApprovalNotificationCommand,
  ): Promise<ApprovalNotificationSendResult> {
    const response = await this.http.request({
      origin: 'https://api.dingtalk.com',
      path: '/v1.0/robot/oToMessages/batchSend',
      method: 'POST',
      headers: { 'x-acs-dingtalk-access-token': command.access.accessToken },
      body: {
        robotCode: command.access.clientId,
        userIds: [command.externalUserId],
        msgKey: 'sampleText',
        msgParam: JSON.stringify({
          content: renderApprovalNotificationText(command.eventType, command.instanceId),
        }),
      },
    });
    const parsed = responseSchema.safeParse(response.body);
    if (!parsed.success) {
      throw new OrgPushError(
        'DINGTALK_APPROVAL_MESSAGE_RESPONSE_INVALID',
        'retryable',
        '钉钉审批通知响应无效',
      );
    }
    return { externalMessageId: parsed.data.processQueryKey };
  }
}
