import { describe, expect, it, vi } from 'vitest';

import type {
  OrgPlatformHttpRequest,
  OrgPlatformHttpResponse,
} from '../../integration/org-platform-http.client.js';
import {
  ApprovalNotificationAdapterRegistry,
  renderApprovalNotificationText,
  type ApprovalNotificationAdapter,
} from './approval-notification.adapter.js';
import { DingTalkApprovalNotificationAdapter } from './dingtalk-approval-notification.adapter.js';
import { FeishuApprovalNotificationAdapter } from './feishu-approval-notification.adapter.js';

const access = {
  accessToken: 'secret-token-must-not-enter-body',
  externalTenantId: 'external-tenant-001',
  clientId: 'application-001',
};

describe('审批通知平台适配器', () => {
  it('钉钉使用企业机器人单聊契约且正文不含审批业务数据', async () => {
    const request = vi.fn<(input: OrgPlatformHttpRequest) => Promise<OrgPlatformHttpResponse>>()
      .mockResolvedValue({
      status: 200, requestId: 'request-001', body: { processQueryKey: 'query-001' },
      });
    const adapter = new DingTalkApprovalNotificationAdapter(
      { request },
    );
    await expect(adapter.send({
      tenantId: 'tenant-001', notificationId: '01J8ZQK7V0A2M4N6P8R0T2W4Y6',
      instanceId: 'instance-001', eventType: 'instance.submitted',
      externalUserId: 'user-001', access,
    })).resolves.toEqual({ externalMessageId: 'query-001' });
    const sent = request.mock.calls[0]?.[0];
    expect(sent?.origin).toBe('https://api.dingtalk.com');
    expect(sent?.path).toBe('/v1.0/robot/oToMessages/batchSend');
    const body = sent?.body;
    expect(body).toMatchObject({
      robotCode: 'application-001', userIds: ['user-001'], msgKey: 'sampleText',
    });
    expect(JSON.stringify(body)).toContain('instance-001');
    expect(JSON.stringify(body)).not.toContain('secret-token');
    expect(JSON.stringify(body)).not.toContain('formData');
  });

  it('飞书以 user_id 发文本并使用通知 ULID 作为平台去重键', async () => {
    const request = vi.fn<(input: OrgPlatformHttpRequest) => Promise<OrgPlatformHttpResponse>>()
      .mockResolvedValue({
      status: 200,
      requestId: 'request-002',
      body: { code: 0, data: { message_id: 'message-001' } },
      });
    const adapter = new FeishuApprovalNotificationAdapter(
      { request },
    );
    await expect(adapter.send({
      tenantId: 'tenant-001', notificationId: '01J8ZQK7V0A2M4N6P8R0T2W4Y6',
      instanceId: 'instance-001', eventType: 'instance.decided',
      externalUserId: 'user-001', access,
    })).resolves.toEqual({ externalMessageId: 'message-001' });
    const sent = request.mock.calls[0]?.[0];
    expect(sent).toMatchObject({
      origin: 'https://open.feishu.cn',
      path: '/open-apis/im/v1/messages',
      query: { receive_id_type: 'user_id' },
    });
    expect(sent?.body).toMatchObject({
      receive_id: 'user-001', msg_type: 'text', uuid: '01J8ZQK7V0A2M4N6P8R0T2W4Y6',
    });
  });

  it('平台成功响应缺少消息回执时失败关闭', async () => {
    const request = vi.fn<(input: OrgPlatformHttpRequest) => Promise<OrgPlatformHttpResponse>>()
      .mockResolvedValue({ status: 200, requestId: undefined, body: { code: 0 } });
    const adapter = new FeishuApprovalNotificationAdapter({ request });
    await expect(adapter.send({
      tenantId: 'tenant-001', notificationId: '01J8ZQK7V0A2M4N6P8R0T2W4Y6',
      instanceId: 'instance-001', eventType: 'instance.submitted',
      externalUserId: 'user-001', access,
    })).rejects.toMatchObject({ code: 'FEISHU_APPROVAL_MESSAGE_RESPONSE_INVALID' });
  });

  it('钉钉成功响应缺少或超长回执时标记为不可判定响应', async () => {
    for (const body of [
      {},
      { processQueryKey: '' },
      { processQueryKey: 'x'.repeat(257) },
    ]) {
      const request = vi.fn<
        (input: OrgPlatformHttpRequest) => Promise<OrgPlatformHttpResponse>
      >().mockResolvedValue({
        status: 200,
        requestId: undefined,
        body,
      });
      const adapter = new DingTalkApprovalNotificationAdapter({ request });
      await expect(adapter.send({
        tenantId: 'tenant-001',
        notificationId: '01J8ZQK7V0A2M4N6P8R0T2W4Y6',
        instanceId: 'instance-001',
        eventType: 'instance.submitted',
        externalUserId: 'user-001',
        access,
      })).rejects.toMatchObject({
        code: 'DINGTALK_APPROVAL_MESSAGE_RESPONSE_INVALID',
        category: 'retryable',
      });
    }
  });

  it('飞书非零业务码或无效消息标识均失败关闭', async () => {
    for (const body of [
      { code: 230_001, data: { message_id: 'message-001' } },
      { code: 0, data: { message_id: '' } },
      { code: 0, data: { message_id: 'x'.repeat(257) } },
      { code: '0', data: { message_id: 'message-001' } },
    ]) {
      const request = vi.fn<
        (input: OrgPlatformHttpRequest) => Promise<OrgPlatformHttpResponse>
      >().mockResolvedValue({
        status: 200,
        requestId: undefined,
        body,
      });
      const adapter = new FeishuApprovalNotificationAdapter({ request });
      await expect(adapter.send({
        tenantId: 'tenant-001',
        notificationId: '01J8ZQK7V0A2M4N6P8R0T2W4Y6',
        instanceId: 'instance-001',
        eventType: 'instance.submitted',
        externalUserId: 'user-001',
        access,
      })).rejects.toMatchObject({
        code: 'FEISHU_APPROVAL_MESSAGE_RESPONSE_INVALID',
      });
    }
  });

  it('适配器注册表强制固定渠道装配并按渠道返回实例', () => {
    const dingtalk = {
      channel: 'dingtalk',
      send: vi.fn(),
    } as unknown as ApprovalNotificationAdapter;
    const feishu = {
      channel: 'feishu',
      send: vi.fn(),
    } as unknown as ApprovalNotificationAdapter;
    const registry = new ApprovalNotificationAdapterRegistry(dingtalk, feishu);
    expect(registry.get('dingtalk')).toBe(dingtalk);
    expect(registry.get('feishu')).toBe(feishu);

    expect(() => new ApprovalNotificationAdapterRegistry(feishu, dingtalk))
      .toThrow('审批通知适配器渠道装配错误');
    expect(() => registry.get('unknown' as 'feishu'))
      .toThrow('审批通知适配器未装配');
  });

  it('固定模板只区分待办与状态更新且不拼接表单正文', () => {
    for (const eventType of [
      'instance.submitted',
      'instance.approver_transferred',
      'instance.approver_added',
    ]) {
      expect(renderApprovalNotificationText(eventType, 'instance-001'))
        .toBe('你有一项审批待处理。请登录 ERP 审批工作台查看。编号：instance-001');
    }
    expect(renderApprovalNotificationText('instance.decided', 'instance-001'))
      .toBe('一项审批状态已更新。请登录 ERP 审批工作台查看。编号：instance-001');
  });
});
