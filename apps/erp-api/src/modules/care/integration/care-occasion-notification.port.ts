import type {
  CareOccasionChannel,
  CareOccasionType,
} from '../domain/index.js';

export interface CareOccasionNotificationRequest {
  readonly tenantId: string;
  readonly occasionTaskId: string;
  readonly employeeId: string;
  readonly occasionType: CareOccasionType;
  readonly purpose: 'employee_care';
  readonly templateCode: string;
  readonly policyVersion: string;
  readonly scheduledAt: string;
  readonly preferredChannels: readonly CareOccasionChannel[];
  readonly sourceDigest: string;
  readonly idempotencyKey: string;
}

export type CareOccasionNotificationReceipt =
  | {
      readonly outcome: 'delivered';
      readonly deliveryEvidenceId: string;
      readonly deliveredAt: string;
      readonly channel: CareOccasionChannel;
    }
  | {
      readonly outcome: 'denied';
      readonly denialCode:
        | 'unsubscribed'
        | 'no_authorized_channel'
        | 'purpose_restricted'
        | 'quiet_hours';
    };

/** 外部通知系统边界；ERP 不解析联系方式，也不生成或传输通知正文。 */
export abstract class CareOccasionNotificationPort {
  abstract dispatch(
    request: CareOccasionNotificationRequest,
  ): Promise<CareOccasionNotificationReceipt>;
}
