import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { OrgPlatformHttpClient } from './org-platform-http.client.js';
import { OrgPlatformTokenService } from './org-platform-token.service.js';
import {
  OrgPushAdapter,
  OrgPushError,
  type ChangeEmployeeStatusCommand,
  type ExternalOrgSnapshot,
  type OrgPushResult,
  type PushDepartmentCommand,
  type PushEmployeeCommand,
} from './org-push.adapter.js';

const feishuResponseSchema = z.object({
  code: z.number().int(),
  data: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const feishuDepartmentPageSchema = z.object({
  has_more: z.boolean().default(false),
  page_token: z.string().optional(),
  items: z.array(z.object({
    department_id: z.string().min(1),
    parent_department_id: z.string(),
    name: z.string(),
    leader_user_id: z.string().optional(),
  }).passthrough()).default([]),
}).passthrough();

const feishuUserPageSchema = z.object({
  has_more: z.boolean().default(false),
  page_token: z.string().optional(),
  items: z.array(z.object({
    user_id: z.string().min(1),
    name: z.string(),
    employee_no: z.string().optional(),
    department_ids: z.array(z.string()).optional(),
    status: z.object({
      is_frozen: z.boolean().optional(),
      is_resigned: z.boolean().optional(),
    }).passthrough().optional(),
  }).passthrough()).default([]),
}).passthrough();

const MAX_SNAPSHOT_OBJECTS = 20_000;

/** 飞书 Contact v3 组织适配器，统一使用可跨应用关联的自定义 department_id/user_id。 */
@Injectable()
export class FeishuOrgPushAdapter extends OrgPushAdapter {
  readonly channel = 'feishu' as const;

  constructor(
    private readonly tokens: OrgPlatformTokenService,
    private readonly http: OrgPlatformHttpClient,
  ) {
    super();
  }

  async pushDepartment(command: PushDepartmentCommand): Promise<OrgPushResult> {
    if (command.status === 'inactive') {
      throw new OrgPushError(
        'FEISHU_DEPARTMENT_DEACTIVATION_REQUIRES_REVIEW',
        'business',
        '飞书部门停用需人工确认成员与子部门迁移',
      );
    }
    const currentId = command.currentExternalId;
    let response: { readonly data: Record<string, unknown> | undefined; readonly requestId: string | undefined };
    try {
      response = await this.call({
        tenantId: command.tenantId,
        path: currentId === null
          ? '/open-apis/contact/v3/departments'
          : `/open-apis/contact/v3/departments/${encodeURIComponent(currentId)}`,
        method: currentId === null ? 'POST' : 'PATCH',
        query: {
          department_id_type: 'department_id',
          user_id_type: 'user_id',
          ...(currentId === null ? { client_token: this.clientToken(command.idempotencyKey) } : {}),
        },
        body: {
          name: command.name,
          parent_department_id: command.parentExternalId ?? '0',
          ...(currentId === null ? { department_id: command.departmentId } : {}),
          ...(command.managerExternalId === null ? {} : { leader_user_id: command.managerExternalId }),
          order: String(command.sortOrder),
          ...(currentId === null ? { create_group_chat: false } : {}),
        },
      });
    } catch (error) {
      if (currentId === null && error instanceof OrgPushError && error.category !== 'retryable') {
        const recovered = await this.getDepartment(command.tenantId, command.departmentId);
        if (recovered) return { externalId: command.departmentId };
      }
      throw error;
    }
    const externalId = currentId ?? this.departmentId(response.data);
    return this.result(externalId, response.requestId);
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
    const response = await this.call({
      tenantId: command.tenantId,
      path: `/open-apis/contact/v3/users/${encodeURIComponent(command.currentExternalId)}`,
      method: 'PATCH',
      query: { user_id_type: 'user_id', department_id_type: 'department_id' },
      body: {
        name: command.displayName,
        employee_no: command.employeeNo,
        department_ids: [...command.departmentExternalIds],
        is_frozen: command.status === 'suspended',
      },
    });
    return this.result(command.currentExternalId, response.requestId);
  }

  async changeEmployeeStatus(command: ChangeEmployeeStatusCommand): Promise<OrgPushResult> {
    if (command.status === 'terminated') {
      return this.deleteEmployee(command.tenantId, command.externalId);
    }
    const response = await this.call({
      tenantId: command.tenantId,
      path: `/open-apis/contact/v3/users/${encodeURIComponent(command.externalId)}`,
      method: 'PATCH',
      query: { user_id_type: 'user_id' },
      body: { is_frozen: command.status === 'suspended' },
    });
    return this.result(command.externalId, response.requestId);
  }

  async fetchSnapshot(tenantId: string): Promise<ExternalOrgSnapshot> {
    const departments = new Map<string, Readonly<Record<string, unknown>>>();
    const employees = new Map<string, Readonly<Record<string, unknown>>>();
    let departmentPageToken: string | undefined;
    let departmentsComplete = false;
    for (let page = 0; page < 400; page += 1) {
      const response = await this.call({
        tenantId,
        path: '/open-apis/contact/v3/departments',
        method: 'GET',
        query: {
          department_id_type: 'department_id',
          user_id_type: 'user_id',
          parent_department_id: '0',
          fetch_child: true,
          page_size: 50,
          ...(departmentPageToken === undefined ? {} : { page_token: departmentPageToken }),
        },
      });
      const parsed = feishuDepartmentPageSchema.safeParse(response.data);
      if (!parsed.success) {
        throw new OrgPushError('FEISHU_SNAPSHOT_INVALID', 'retryable', '飞书部门快照无效');
      }
      for (const item of parsed.data.items) {
        departments.set(item.department_id, Object.freeze({
          externalId: item.department_id,
          parentExternalId: item.parent_department_id,
          name: item.name,
          ...(item.leader_user_id === undefined ? {} : { managerExternalId: item.leader_user_id }),
        }));
        this.assertSnapshotSize(departments.size + employees.size);
      }
      if (!parsed.data.has_more) {
        departmentsComplete = true;
        break;
      }
      if (parsed.data.page_token === undefined || parsed.data.page_token === departmentPageToken) {
        throw new OrgPushError('FEISHU_SNAPSHOT_CURSOR_INVALID', 'retryable', '飞书分页游标无效');
      }
      departmentPageToken = parsed.data.page_token;
    }
    if (!departmentsComplete) {
      throw new OrgPushError('FEISHU_SNAPSHOT_PAGE_LIMIT', 'retryable', '飞书部门分页超过安全上限');
    }
    let consumedEmployeePages = 0;
    for (const departmentId of ['0', ...departments.keys()]) {
      let employeePageToken: string | undefined;
      let employeesComplete = false;
      while (consumedEmployeePages < 400) {
        consumedEmployeePages += 1;
        const response = await this.call({
          tenantId,
          path: '/open-apis/contact/v3/users/find_by_department',
          method: 'GET',
          query: {
            user_id_type: 'user_id',
            department_id_type: 'department_id',
            department_id: departmentId,
            page_size: 50,
            ...(employeePageToken === undefined ? {} : { page_token: employeePageToken }),
          },
        });
        const parsed = feishuUserPageSchema.safeParse(response.data);
        if (!parsed.success) {
          throw new OrgPushError('FEISHU_SNAPSHOT_INVALID', 'retryable', '飞书员工快照无效');
        }
        for (const user of parsed.data.items) {
          employees.set(user.user_id, Object.freeze({
            externalId: user.user_id,
            displayName: user.name,
            employeeNo: user.employee_no ?? '',
            departmentExternalIds: [...(user.department_ids ?? [])],
            frozen: user.status?.is_frozen ?? false,
            suspended: user.status?.is_frozen ?? false,
            resigned: user.status?.is_resigned ?? false,
          }));
          this.assertSnapshotSize(departments.size + employees.size);
        }
        if (!parsed.data.has_more) {
          employeesComplete = true;
          break;
        }
        if (parsed.data.page_token === undefined || parsed.data.page_token === employeePageToken) {
          throw new OrgPushError('FEISHU_SNAPSHOT_CURSOR_INVALID', 'retryable', '飞书分页游标无效');
        }
        employeePageToken = parsed.data.page_token;
      }
      if (!employeesComplete) {
        throw new OrgPushError('FEISHU_SNAPSHOT_PAGE_LIMIT', 'retryable', '飞书员工分页超过安全上限');
      }
    }
    return { departments, employees };
  }

  private async deleteEmployee(tenantId: string, externalId: string): Promise<OrgPushResult> {
    const response = await this.call({
      tenantId,
      path: `/open-apis/contact/v3/users/${encodeURIComponent(externalId)}`,
      method: 'DELETE',
      query: { user_id_type: 'user_id' },
    });
    return this.result(externalId, response.requestId);
  }

  /** 以自定义 department_id 确认已存在对象，用于外部成功、本地提交前崩溃的恢复。 */
  private async getDepartment(tenantId: string, departmentId: string): Promise<boolean> {
    try {
      const response = await this.call({
        tenantId,
        path: `/open-apis/contact/v3/departments/${encodeURIComponent(departmentId)}`,
        method: 'GET',
        query: { department_id_type: 'department_id', user_id_type: 'user_id' },
      });
      return z.object({ department: z.object({ department_id: z.string() }) })
        .passthrough().safeParse(response.data).success;
    } catch {
      return false;
    }
  }

  private async call(input: {
    readonly tenantId: string;
    readonly path: string;
    readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    readonly query?: Readonly<Record<string, string | number | boolean>>;
    readonly body?: Readonly<Record<string, unknown>>;
  }, allowTokenRefresh = true): Promise<{
    readonly data: Record<string, unknown> | undefined;
    readonly requestId: string | undefined;
  }> {
    const access = await this.tokens.getAccess(input.tenantId, 'feishu');
    let result;
    try {
      result = await this.http.request({
        origin: 'https://open.feishu.cn',
        path: input.path,
        method: input.method,
        headers: { Authorization: `Bearer ${access.accessToken}` },
        ...(input.query === undefined ? {} : { query: input.query }),
        ...(input.body === undefined ? {} : { body: input.body }),
      });
    } catch (error) {
      if (allowTokenRefresh && error instanceof OrgPushError && error.status === 401) {
        this.tokens.invalidate(input.tenantId, 'feishu', access.accessToken);
        return this.call(input, false);
      }
      throw error;
    }
    const parsed = feishuResponseSchema.safeParse(result.body);
    if (!parsed.success) {
      throw new OrgPushError('FEISHU_RESPONSE_INVALID', 'retryable', '飞书响应无效');
    }
    if (parsed.data.code !== 0) {
      const retryable = parsed.data.code === 99991400 || parsed.data.code === 99991401;
      throw new OrgPushError(
        `FEISHU_${Math.abs(parsed.data.code)}`,
        retryable ? 'retryable' : 'business',
        '飞书业务调用失败',
      );
    }
    return { data: parsed.data.data, requestId: result.requestId };
  }

  private departmentId(data: Record<string, unknown> | undefined): string {
    const parsed = z.object({
      department: z.object({ department_id: z.string().min(1) }).passthrough(),
    }).passthrough().safeParse(data);
    if (!parsed.success) {
      throw new OrgPushError('FEISHU_DEPARTMENT_ID_MISSING', 'retryable', '飞书响应缺少部门标识');
    }
    return parsed.data.department.department_id;
  }

  private clientToken(idempotencyKey: string): string {
    return createHash('sha256').update(idempotencyKey, 'utf8').digest('base64url');
  }

  private assertSnapshotSize(size: number): void {
    if (size > MAX_SNAPSHOT_OBJECTS) {
      throw new OrgPushError('FEISHU_SNAPSHOT_TOO_LARGE', 'business', '飞书通讯录规模超过安全上限');
    }
  }

  private result(externalId: string, requestId: string | undefined): OrgPushResult {
    return { externalId, ...(requestId === undefined ? {} : { requestId }) };
  }
}
