import { createHash, createHmac, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { OpOrgHttpClient } from './op-org-http.client.js';
import { OrgPlatformCredentialService } from './org-platform-credential.service.js';
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

const successSchema = z.object({
  code: z.literal('OK'),
  data: z.object({ externalId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/) }).strict(),
}).strict();
const snapshotSchema = z.object({
  code: z.literal('OK'),
  data: z.object({
    departments: z.array(z.object({
      externalId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
      name: z.string().min(1).max(256),
      parentExternalId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).nullable(),
      status: z.enum(['active', 'inactive']),
    }).strict()).max(20_000),
    employees: z.array(z.object({
      externalId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
      employeeNo: z.string().min(1).max(128),
      displayName: z.string().min(1).max(256),
      departmentExternalIds: z.array(z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/)).max(100),
      suspended: z.boolean(),
      resigned: z.boolean(),
    }).strict()).max(20_000),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.data.departments.length + value.data.employees.length > 20_000) {
    context.addIssue({ code: 'custom', path: ['data'], message: 'OP 组织快照超过安全上限' });
  }
});

/** OP 组织消费者适配器；只接收 ERP canonical command，以独立 HMAC 服务身份调用。 */
@Injectable()
export class OpOrgPushAdapter extends OrgPushAdapter {
  readonly channel = 'op' as const;

  constructor(
    private readonly credentials: OrgPlatformCredentialService,
    private readonly http: OpOrgHttpClient,
  ) {
    super();
  }

  async pushDepartment(command: PushDepartmentCommand): Promise<OrgPushResult> {
    const externalId = command.currentExternalId ?? command.departmentId;
    const body = JSON.stringify({
      schemaVersion: '1.0', externalId, erpDepartmentId: command.departmentId,
      version: command.version, code: command.code, name: command.name,
      status: command.status, parentExternalId: command.parentExternalId,
      managerExternalId: command.managerExternalId, sortOrder: command.sortOrder,
    });
    return this.put(
      command.tenantId, `/erp/v1/org/departments/${externalId}`,
      command.idempotencyKey, body, externalId,
    );
  }

  async pushEmployee(command: PushEmployeeCommand): Promise<OrgPushResult> {
    const externalId = command.currentExternalId ?? command.employeeId;
    const body = JSON.stringify({
      schemaVersion: '1.0', externalId, erpEmployeeId: command.employeeId,
      version: command.version, employeeNo: command.employeeNo,
      displayName: command.displayName, status: command.status,
      departmentExternalIds: [...command.departmentExternalIds],
      primaryDepartmentExternalId: command.primaryDepartmentExternalId,
    });
    return this.put(
      command.tenantId, `/erp/v1/org/employees/${externalId}`,
      command.idempotencyKey, body, externalId,
    );
  }

  provisionEmployee(command: ProvisionEmployeeCommand): Promise<ProvisionEmployeeResult> {
    void command;
    return Promise.reject(new OrgPushError(
      'OP_IDENTITY_BINDING_REQUIRED', 'business',
      'OP 身份绑定必须通过独立身份联合流程，不允许复用私密开户通道',
    ));
  }

  async changeEmployeeStatus(command: ChangeEmployeeStatusCommand): Promise<OrgPushResult> {
    const body = JSON.stringify({
      schemaVersion: '1.0', externalId: command.externalId,
      erpEmployeeId: command.employeeId, version: command.version, status: command.status,
    });
    return this.put(
      command.tenantId, `/erp/v1/org/employees/${command.externalId}`,
      command.idempotencyKey, body, command.externalId,
    );
  }

  async fetchSnapshot(tenantId: string): Promise<ExternalOrgSnapshot> {
    const response = await this.call(
      tenantId, 'GET', '/erp/v1/org/snapshot', `snapshot:${tenantId}`, undefined,
    );
    const parsed = snapshotSchema.safeParse(response.body);
    if (!parsed.success) {
      throw new OrgPushError('OP_ORG_SNAPSHOT_INVALID', 'retryable', 'OP 组织快照格式无效');
    }
    return {
      departments: new Map(parsed.data.data.departments.map((item) => [
        item.externalId,
        Object.freeze({
          name: item.name, parentExternalId: item.parentExternalId, status: item.status,
        }),
      ])),
      employees: new Map(parsed.data.data.employees.map((item) => [
        item.externalId,
        Object.freeze({
          employeeNo: item.employeeNo, displayName: item.displayName,
          departmentExternalIds: [...item.departmentExternalIds],
          suspended: item.suspended, resigned: item.resigned,
        }),
      ])),
    };
  }

  private async put(
    tenantId: string,
    path: string,
    idempotencyKey: string,
    body: string,
    expectedExternalId: string,
  ): Promise<OrgPushResult> {
    const response = await this.call(tenantId, 'PUT', path, idempotencyKey, body);
    const parsed = successSchema.safeParse(response.body);
    if (!parsed.success || parsed.data.data.externalId !== expectedExternalId) {
      throw new OrgPushError('OP_ORG_RESPONSE_INVALID', 'retryable', 'OP 组织响应格式无效');
    }
    return {
      externalId: parsed.data.data.externalId,
      ...(response.requestId === undefined ? {} : { requestId: response.requestId }),
    };
  }

  private async call(
    tenantId: string,
    method: 'GET' | 'PUT',
    path: string,
    idempotencyKey: string,
    body: string | undefined,
  ) {
    if (!/^[A-Za-z0-9._:-]{8,512}$/.test(idempotencyKey)) {
      throw new OrgPushError('OP_IDEMPOTENCY_KEY_INVALID', 'conflict', 'OP 幂等键非法');
    }
    const credential = await this.credentials.resolve(tenantId, 'op');
    const timestamp = String(Date.now());
    const nonce = randomBytes(16).toString('base64url');
    const bodyHash = createHash('sha256').update(body ?? '', 'utf8').digest('base64url');
    const canonical = [
      timestamp, nonce, method, path, credential.externalTenantId, idempotencyKey, bodyHash,
    ].join('\n');
    const signature = createHmac('sha256', credential.clientSecret)
      .update(canonical, 'utf8').digest('hex');
    return this.http.request({
      method, path,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-gaoq-erp-client-id': credential.clientId,
        'x-gaoq-erp-external-tenant-id': credential.externalTenantId,
        'x-gaoq-erp-timestamp': timestamp,
        'x-gaoq-erp-nonce': nonce,
        'x-gaoq-erp-idempotency-key': idempotencyKey,
        'x-gaoq-erp-signature-algorithm': 'hmac-sha256',
        'x-gaoq-erp-signature': signature,
      },
      ...(body === undefined ? {} : { body }),
    });
  }
}
