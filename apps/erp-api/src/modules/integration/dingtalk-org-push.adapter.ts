import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { OrgPlatformHttpClient } from './org-platform-http.client.js';
import { OrgPlatformTokenService } from './org-platform-token.service.js';
import {
  OrgPushAdapter,
  OrgPushError,
  type ChangeEmployeeStatusCommand,
  type ExternalOrgSnapshot,
  type ProvisionEmployeeCommand,
  type ProvisionEmployeeResult,
  type OrgPushResult,
  type PushDepartmentCommand,
  type PushEmployeeCommand,
} from './org-push.adapter.js';

const dingtalkResponseSchema = z.object({
  errcode: z.number().int().default(0),
  request_id: z.string().optional(),
  result: z.unknown().optional(),
}).passthrough();

const dingtalkDepartmentListSchema = z.array(z.object({
  dept_id: z.union([z.string(), z.number()]),
  parent_id: z.union([z.string(), z.number()]).optional(),
  name: z.string().optional(),
  source_identifier: z.string().optional(),
}).passthrough());

const dingtalkUserPageSchema = z.object({
  list: z.array(z.object({
    userid: z.string().min(1),
    name: z.string().optional(),
    job_number: z.string().optional(),
    dept_id_list: z.array(z.union([z.string(), z.number()])).optional(),
    active: z.boolean().optional(),
  }).passthrough()).default([]),
  has_more: z.boolean().default(false),
  next_cursor: z.number().int().nonnegative().optional(),
}).passthrough();

const dingtalkProvisionedUserSchema = z.object({
  userid: z.string().min(1).max(128),
  unionid: z.string().min(1).max(256),
  job_number: z.string().max(128).optional(),
}).passthrough();

const MAX_SNAPSHOT_OBJECTS = 20_000;

/** 钉钉通讯录适配器；兼容其当前仍用于写通讯录的 topapi/v2 接口。 */
@Injectable()
export class DingTalkOrgPushAdapter extends OrgPushAdapter {
  readonly channel = 'dingtalk' as const;

  constructor(
    private readonly tokens: OrgPlatformTokenService,
    private readonly http: OrgPlatformHttpClient,
  ) {
    super();
  }

  async pushDepartment(command: PushDepartmentCommand): Promise<OrgPushResult> {
    if (command.status === 'inactive') {
      throw new OrgPushError(
        'DINGTALK_DEPARTMENT_DEACTIVATION_REQUIRES_REVIEW',
        'business',
        '钉钉部门停用需人工确认成员与子部门迁移',
      );
    }
    const parentId = this.numericDepartmentId(command.parentExternalId ?? '1');
    const body = command.currentExternalId === null
      ? {
          name: command.name,
          parent_id: parentId,
          order: command.sortOrder,
          create_dept_group: false,
          source_identifier: command.departmentId,
        }
      : {
          dept_id: this.numericDepartmentId(command.currentExternalId),
          name: command.name,
          parent_id: parentId,
          order: command.sortOrder,
        };
    let response: z.infer<typeof dingtalkResponseSchema>;
    try {
      response = await this.call(
        command.tenantId,
        command.currentExternalId === null
          ? '/topapi/v2/department/create'
          : '/topapi/v2/department/update',
        body,
      );
    } catch (error) {
      if (
        command.currentExternalId === null &&
        error instanceof OrgPushError &&
        error.category !== 'retryable'
      ) {
        const recoveredId = await this.findDepartmentBySourceIdentifier(
          command.tenantId,
          command.departmentId,
        );
        if (recoveredId !== null) return { externalId: recoveredId };
      }
      throw error;
    }
    const externalId = command.currentExternalId
      ?? this.requiredResultId(
        this.resultField(response.result, 'dept_id'),
        'DINGTALK_DEPARTMENT_ID_MISSING',
      );
    return this.result(externalId, response.request_id);
  }

  async pushEmployee(command: PushEmployeeCommand): Promise<OrgPushResult> {
    if (command.currentExternalId === null) {
      throw new OrgPushError(
        'ORG_EMPLOYEE_PREPROVISION_REQUIRED',
        'business',
        '未绑定员工需经私密资料通道预开通',
      );
    }
    if (command.status === 'terminated') {
      return this.deleteEmployee(command.tenantId, command.currentExternalId);
    }
    if (command.status === 'suspended') {
      throw new OrgPushError(
        'DINGTALK_SUSPEND_REQUIRES_REVIEW',
        'business',
        '钉钉员工停用需人工执行账号安全流程',
      );
    }
    const response = await this.call(command.tenantId, '/topapi/v2/user/update', {
      userid: command.currentExternalId,
      name: command.displayName,
      job_number: command.employeeNo,
      dept_id_list: command.departmentExternalIds.join(','),
    });
    return this.result(command.currentExternalId, response.request_id);
  }

  async provisionEmployee(command: ProvisionEmployeeCommand): Promise<ProvisionEmployeeResult> {
    if (command.contact.mobile === undefined) {
      throw new OrgPushError(
        'DINGTALK_PROVISIONING_MOBILE_REQUIRED',
        'business',
        '钉钉首次开户必须提供手机号',
      );
    }
    let createRequestId: string | undefined;
    try {
      const response = await this.call(command.tenantId, '/topapi/v2/user/create', {
        userid: command.externalUserId,
        name: command.displayName,
        mobile: command.contact.mobile.subscriberNumber,
        state_code: command.contact.mobile.countryCode.slice(1),
        job_number: command.employeeNo,
        dept_id_list: command.departmentExternalIds.join(','),
        hide_mobile: true,
        ...(command.contact.email === undefined ? {} : { email: command.contact.email }),
      });
      createRequestId = response.request_id;
    } catch (error) {
      if (!(error instanceof OrgPushError) || error.category === 'retryable') throw error;
      const recovered = await this.tryGetProvisionedUser(command);
      if (recovered !== null) return recovered;
      throw error;
    }
    const identity = await this.getProvisionedUser(command);
    return {
      ...identity,
      ...(createRequestId === undefined ? {} : { requestId: createRequestId }),
    };
  }

  async changeEmployeeStatus(command: ChangeEmployeeStatusCommand): Promise<OrgPushResult> {
    if (command.status === 'terminated') {
      return this.deleteEmployee(command.tenantId, command.externalId);
    }
    if (command.status === 'suspended') {
      throw new OrgPushError(
        'DINGTALK_SUSPEND_REQUIRES_REVIEW',
        'business',
        '钉钉员工停用需人工执行账号安全流程',
      );
    }
    return { externalId: command.externalId };
  }

  async fetchSnapshot(tenantId: string): Promise<ExternalOrgSnapshot> {
    const departments = new Map<string, Readonly<Record<string, unknown>>>();
    const employees = new Map<string, Readonly<Record<string, unknown>>>();
    const pendingDepartmentIds = ['1'];
    const traversed = new Set<string>();
    while (pendingDepartmentIds.length > 0) {
      const parentId = pendingDepartmentIds.shift();
      if (parentId === undefined || traversed.has(parentId)) continue;
      traversed.add(parentId);
      const response = await this.call(tenantId, '/topapi/v2/department/listsub', {
        dept_id: this.numericDepartmentId(parentId),
      });
      const children = dingtalkDepartmentListSchema.safeParse(response.result ?? []);
      if (!children.success) {
        throw new OrgPushError('DINGTALK_SNAPSHOT_INVALID', 'retryable', '钉钉部门快照无效');
      }
      for (const item of children.data) {
        const externalId = String(item.dept_id);
        departments.set(externalId, Object.freeze({
          externalId,
          parentExternalId: item.parent_id === undefined ? parentId : String(item.parent_id),
          name: item.name ?? '',
        }));
        pendingDepartmentIds.push(externalId);
        this.assertSnapshotSize(departments.size + employees.size);
      }
    }
    for (const departmentId of ['1', ...departments.keys()]) {
      let cursor = 0;
      for (let page = 0; page < 200; page += 1) {
        const response = await this.call(tenantId, '/topapi/v2/user/list', {
          dept_id: this.numericDepartmentId(departmentId),
          cursor,
          size: 100,
          contain_access_limit: false,
        });
        const parsed = dingtalkUserPageSchema.safeParse(response.result);
        if (!parsed.success) {
          throw new OrgPushError('DINGTALK_SNAPSHOT_INVALID', 'retryable', '钉钉员工快照无效');
        }
        for (const user of parsed.data.list) {
          employees.set(user.userid, Object.freeze({
            externalId: user.userid,
            displayName: user.name ?? '',
            employeeNo: user.job_number ?? '',
            departmentExternalIds: (user.dept_id_list ?? []).map(String),
            active: user.active ?? true,
            suspended: !(user.active ?? true),
          }));
          this.assertSnapshotSize(departments.size + employees.size);
        }
        if (!parsed.data.has_more) {
          cursor = -1;
          break;
        }
        if (parsed.data.next_cursor === undefined || parsed.data.next_cursor === cursor) {
          throw new OrgPushError('DINGTALK_SNAPSHOT_CURSOR_INVALID', 'retryable', '钉钉分页游标无效');
        }
        cursor = parsed.data.next_cursor;
      }
      if (cursor !== -1) {
        throw new OrgPushError('DINGTALK_SNAPSHOT_PAGE_LIMIT', 'retryable', '钉钉分页超过安全上限');
      }
    }
    return { departments, employees };
  }

  private async deleteEmployee(tenantId: string, externalId: string): Promise<OrgPushResult> {
    const response = await this.call(tenantId, '/topapi/v2/user/delete', { userid: externalId });
    return this.result(externalId, response.request_id);
  }

  /** 创建返回后再固定查询 unionId，不依赖平台创建响应的可选字段。 */
  private async getProvisionedUser(
    command: ProvisionEmployeeCommand,
  ): Promise<ProvisionEmployeeResult> {
    const response = await this.call(command.tenantId, '/topapi/v2/user/get', {
      userid: command.externalUserId,
      language: 'zh_CN',
    });
    const parsed = dingtalkProvisionedUserSchema.safeParse(response.result);
    if (!parsed.success || parsed.data.userid !== command.externalUserId) {
      throw new OrgPushError(
        'DINGTALK_PROVISIONING_IDENTITY_INVALID',
        'conflict',
        '钉钉开户身份响应无效',
      );
    }
    if (parsed.data.job_number !== command.employeeNo) {
      throw new OrgPushError(
        'DINGTALK_PROVISIONING_IDENTITY_CONFLICT',
        'conflict',
        '钉钉确定性用户标识已被其他员工占用',
      );
    }
    return {
      externalUserId: parsed.data.userid,
      unionId: parsed.data.unionid,
      ...(response.request_id === undefined ? {} : { requestId: response.request_id }),
    };
  }

  private async tryGetProvisionedUser(
    command: ProvisionEmployeeCommand,
  ): Promise<ProvisionEmployeeResult | null> {
    try {
      return await this.getProvisionedUser(command);
    } catch (error) {
      if (error instanceof OrgPushError) {
        if (
          error.code === 'DINGTALK_PROVISIONING_IDENTITY_CONFLICT' ||
          error.category === 'retryable'
        ) throw error;
      }
      return null;
    }
  }

  /** 外部创建成功、本地提交前崩溃时，以 ERP 稳定来源标识恢复映射，避免重复建部门。 */
  private async findDepartmentBySourceIdentifier(
    tenantId: string,
    sourceIdentifier: string,
  ): Promise<string | null> {
    const pending = ['1'];
    const traversed = new Set<string>();
    while (pending.length > 0) {
      const parentId = pending.shift();
      if (parentId === undefined || traversed.has(parentId)) continue;
      traversed.add(parentId);
      const response = await this.call(tenantId, '/topapi/v2/department/listsub', {
        dept_id: this.numericDepartmentId(parentId),
      });
      const children = dingtalkDepartmentListSchema.safeParse(response.result ?? []);
      if (!children.success) {
        throw new OrgPushError('DINGTALK_SNAPSHOT_INVALID', 'retryable', '钉钉部门快照无效');
      }
      for (const child of children.data) {
        const childId = String(child.dept_id);
        if (child.source_identifier === sourceIdentifier) return childId;
        pending.push(childId);
        this.assertSnapshotSize(traversed.size + pending.length);
      }
    }
    return null;
  }

  private async call(
    tenantId: string,
    path: string,
    body: Readonly<Record<string, unknown>>,
    allowTokenRefresh = true,
  ): Promise<z.infer<typeof dingtalkResponseSchema>> {
    const access = await this.tokens.getAccess(tenantId, 'dingtalk');
    let result;
    try {
      result = await this.http.request({
        origin: 'https://oapi.dingtalk.com',
        path,
        method: 'POST',
        sensitiveQuery: { access_token: access.accessToken },
        body,
      });
    } catch (error) {
      if (allowTokenRefresh && error instanceof OrgPushError && error.status === 401) {
        this.tokens.invalidate(tenantId, 'dingtalk', access.accessToken);
        return this.call(tenantId, path, body, false);
      }
      throw error;
    }
    const parsed = dingtalkResponseSchema.safeParse(result.body);
    if (!parsed.success) {
      throw new OrgPushError('DINGTALK_RESPONSE_INVALID', 'retryable', '钉钉响应无效');
    }
    if (parsed.data.errcode !== 0) {
      const retryable = parsed.data.errcode === -1 || parsed.data.errcode === 88;
      throw new OrgPushError(
        `DINGTALK_${Math.abs(parsed.data.errcode)}`,
        retryable ? 'retryable' : 'business',
        '钉钉业务调用失败',
      );
    }
    return parsed.data;
  }

  private numericDepartmentId(value: string): number {
    if (!/^\d{1,20}$/.test(value)) {
      throw new OrgPushError('DINGTALK_DEPARTMENT_ID_INVALID', 'conflict', '钉钉部门映射无效');
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new OrgPushError('DINGTALK_DEPARTMENT_ID_INVALID', 'conflict', '钉钉部门映射无效');
    }
    return parsed;
  }

  private requiredResultId(value: unknown, code: string): string {
    if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d+$/.test(String(value))) {
      throw new OrgPushError(code, 'retryable', '钉钉响应缺少对象标识');
    }
    return String(value);
  }

  private resultField(result: unknown, field: string): unknown {
    if (typeof result !== 'object' || result === null || Array.isArray(result)) return undefined;
    return (result as Record<string, unknown>)[field];
  }

  private assertSnapshotSize(size: number): void {
    if (size > MAX_SNAPSHOT_OBJECTS) {
      throw new OrgPushError('DINGTALK_SNAPSHOT_TOO_LARGE', 'business', '钉钉通讯录规模超过安全上限');
    }
  }

  private result(externalId: string, requestId: string | undefined): OrgPushResult {
    return { externalId, ...(requestId === undefined ? {} : { requestId }) };
  }
}
