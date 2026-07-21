/** 首期同时正式支持的组织下发渠道。 */
export type OrgPushChannel = 'dingtalk' | 'feishu';

export interface PushDepartmentCommand {
  readonly tenantId: string;
  readonly departmentId: string;
  readonly version: number;
  readonly code: string;
  readonly name: string;
  readonly status: 'active' | 'inactive';
  readonly parentExternalId: string | null;
  readonly managerExternalId: string | null;
  readonly sortOrder: number;
  readonly currentExternalId: string | null;
  readonly idempotencyKey: string;
}

export interface PushEmployeeCommand {
  readonly tenantId: string;
  readonly employeeId: string;
  readonly version: number;
  readonly employeeNo: string;
  readonly displayName: string;
  readonly status: 'probation' | 'active' | 'suspended' | 'terminated';
  readonly departmentExternalIds: readonly string[];
  readonly primaryDepartmentExternalId: string;
  readonly currentExternalId: string | null;
  readonly idempotencyKey: string;
}

export interface OrgPushResult {
  readonly externalId: string;
  readonly requestId?: string;
}

export interface ChangeEmployeeStatusCommand {
  readonly tenantId: string;
  readonly employeeId: string;
  readonly externalId: string;
  readonly version: number;
  readonly status: 'probation' | 'active' | 'suspended' | 'terminated';
  readonly idempotencyKey: string;
}

export interface ExternalOrgSnapshot {
  readonly departments: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
  readonly employees: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
}

/** 平台适配器只接收 canonical command，禁止接收领域数据库对象或上游 Token。 */
export abstract class OrgPushAdapter {
  abstract readonly channel: OrgPushChannel;

  abstract pushDepartment(command: PushDepartmentCommand): Promise<OrgPushResult>;

  abstract pushEmployee(command: PushEmployeeCommand): Promise<OrgPushResult>;

  abstract changeEmployeeStatus(command: ChangeEmployeeStatusCommand): Promise<OrgPushResult>;

  abstract fetchSnapshot(tenantId: string): Promise<ExternalOrgSnapshot>;
}

export type OrgPushFailureCategory = 'retryable' | 'business' | 'conflict';

/** 适配器稳定错误；消息不得包含凭据、原始响应或个人敏感信息。 */
export class OrgPushError extends Error {
  constructor(
    readonly code: string,
    readonly category: OrgPushFailureCategory,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OrgPushError';
  }
}

export const DINGTALK_ORG_PUSH_ADAPTER = Symbol('DINGTALK_ORG_PUSH_ADAPTER');
export const FEISHU_ORG_PUSH_ADAPTER = Symbol('FEISHU_ORG_PUSH_ADAPTER');

/** 同时持有双平台一级适配器，禁止按“先一个平台、后补另一个平台”装配。 */
export class OrgPushAdapterRegistry {
  private readonly adapters: ReadonlyMap<OrgPushChannel, OrgPushAdapter>;

  constructor(dingtalk: OrgPushAdapter, feishu: OrgPushAdapter) {
    if (dingtalk.channel !== 'dingtalk' || feishu.channel !== 'feishu') {
      throw new Error('组织下发适配器渠道装配错误');
    }
    this.adapters = new Map([
      ['dingtalk', dingtalk],
      ['feishu', feishu],
    ]);
  }

  get(channel: OrgPushChannel): OrgPushAdapter {
    const adapter = this.adapters.get(channel);
    if (adapter === undefined) throw new Error(`组织下发适配器未装配：${channel}`);
    return adapter;
  }
}
