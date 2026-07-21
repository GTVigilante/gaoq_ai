import { Mongoose } from 'mongoose';
import type { Model, Schema } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  OrgDepartmentRecordSchema,
  OrgEmployeeRecordSchema,
  OrgJobLevelRecordSchema,
  OrgPositionRecordSchema,
  OrgPersonRecordSchema,
  OrgEmploymentRecordSchema,
  OrgEmployeeNumberSequenceRecordSchema,
  type OrgDepartmentRecord,
  type OrgEmployeeRecord,
  type OrgJobLevelRecord,
  type OrgPositionRecord,
  type OrgPersonRecord,
  type OrgEmploymentRecord,
  type OrgEmployeeNumberSequenceRecord,
} from './org.schemas.js';
import { OutboxRecordSchema, type OutboxRecord } from './outbox.schema.js';

/**
 * 不连库校验：独立 Mongoose 实例仅用于注册模型，
 * document.validate() 在内存中执行校验器，不发起任何连接。
 */
const mongoose = new Mongoose();

const DepartmentModel = mongoose.model<OrgDepartmentRecord>(
  'SpecOrgDepartment',
  OrgDepartmentRecordSchema,
);
const EmployeeModel = mongoose.model<OrgEmployeeRecord>('SpecOrgEmployee', OrgEmployeeRecordSchema);
const PositionModel = mongoose.model<OrgPositionRecord>('SpecOrgPosition', OrgPositionRecordSchema);
const JobLevelModel = mongoose.model<OrgJobLevelRecord>(
  'SpecOrgJobLevel',
  OrgJobLevelRecordSchema,
);
const PersonModel = mongoose.model<OrgPersonRecord>('SpecOrgPerson', OrgPersonRecordSchema);
const EmploymentModel = mongoose.model<OrgEmploymentRecord>(
  'SpecOrgEmployment', OrgEmploymentRecordSchema,
);
const EmployeeNumberSequenceModel = mongoose.model<OrgEmployeeNumberSequenceRecord>(
  'SpecOrgEmployeeNumberSequence', OrgEmployeeNumberSequenceRecordSchema,
);
const OutboxModel = mongoose.model<OutboxRecord>('SpecOutbox', OutboxRecordSchema);

/** 校验文档，期望通过；失败时抛出带校验明细的异常。 */
async function expectValid(doc: unknown): Promise<void> {
  await (doc as { validate(): Promise<void> }).validate();
}

/** 校验文档，期望失败且错误信息命中指定字段。 */
async function expectInvalid(doc: unknown, path: string): Promise<void> {
  await expect((doc as { validate(): Promise<void> }).validate()).rejects.toThrowError(
    new RegExp(path),
  );
}

function validDepartment(): Record<string, unknown> {
  return {
    id: 'dept-1',
    tenantId: 'tenant-a',
    code: 'HR',
    name: '人力资源部',
    status: 'active',
    parentId: null,
    managerId: null,
    sortOrder: 1,
    version: 1,
  };
}

function validEmployee(): Record<string, unknown> {
  return {
    id: 'emp-1',
    tenantId: 'tenant-a',
    employeeNo: 'E0001',
    displayName: '张三',
    status: 'probation',
    departmentIds: ['dept-1'],
    primaryDepartmentId: 'dept-1',
    positionIds: [],
    jobLevelId: null,
    version: 1,
  };
}

function validJobLevel(): Record<string, unknown> {
  return {
    id: 'jl-1',
    tenantId: 'tenant-a',
    code: 'P5',
    name: '资深工程师',
    track: 'professional',
    rank: 5,
    version: 1,
  };
}

function validOutbox(): Record<string, unknown> {
  return {
    eventId: '01J8ZQK7V0A2M4N6P8R0T2W4Y6',
    tenantId: 'tenant-a',
    aggregateType: 'org.department',
    aggregateId: 'dept-1',
    aggregateVersion: 1,
    eventType: 'org.department.created',
    envelope: { payload: { name: '人力资源部' } },
    status: 'pending',
    attempts: 0,
    nextAttemptAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function validPerson(): Record<string, unknown> {
  return {
    id: 'person-1', tenantId: 'tenant-a', sourceCandidateId: 'candidate-1',
    identityEvidenceId: 'identity-evidence-1', status: 'active', version: 1,
  };
}

function validEmployment(): Record<string, unknown> {
  return {
    id: 'employment-1', tenantId: 'tenant-a', personId: 'person-1',
    employeeId: 'employee-1', onboardingInstanceId: 'onboarding-1', offerId: 'offer-1',
    onboardingCompletionEvidenceId: 'onboarding-evidence-1',
    signedEvidenceId: 'signed-evidence-1', status: 'probation',
    effectiveFrom: '2026-08-01', effectiveTo: null, version: 1,
  };
}

describe('OrgDepartmentRecordSchema 校验', () => {
  it('合法文档通过校验', async () => {
    await expectValid(new DepartmentModel(validDepartment()));
  });

  it('status 仅允许 active/inactive', async () => {
    await expectInvalid(
      new DepartmentModel({ ...validDepartment(), status: 'archived' }),
      'status',
    );
  });

  it('sortOrder 必须为非负整数', async () => {
    await expectInvalid(new DepartmentModel({ ...validDepartment(), sortOrder: -1 }), 'sortOrder');
    await expectInvalid(
      new DepartmentModel({ ...validDepartment(), sortOrder: 1.5 }),
      'sortOrder',
    );
  });

  it('version 必须为 >=1 的整数', async () => {
    await expectInvalid(new DepartmentModel({ ...validDepartment(), version: 0 }), 'version');
    await expectInvalid(new DepartmentModel({ ...validDepartment(), version: 2.5 }), 'version');
  });

  it('名称超长（>256）与标识超长（>128）被拒绝', async () => {
    await expectInvalid(
      new DepartmentModel({ ...validDepartment(), name: '很'.repeat(257) }),
      'name',
    );
    await expectInvalid(
      new DepartmentModel({ ...validDepartment(), code: 'c'.repeat(129) }),
      'code',
    );
  });
});

describe('OrgEmployeeRecordSchema 校验', () => {
  it('合法文档通过校验（positionIds 允许为空数组）', async () => {
    await expectValid(new EmployeeModel(validEmployee()));
  });

  it('departmentIds 为空数组被拒绝', async () => {
    await expectInvalid(
      new EmployeeModel({ ...validEmployee(), departmentIds: [] }),
      'departmentIds',
    );
  });

  it('departmentIds 超过 500 个被拒绝', async () => {
    const departmentIds = Array.from({ length: 501 }, (_, index) => `dept-${index}`);
    await expectInvalid(
      new EmployeeModel({ ...validEmployee(), departmentIds, primaryDepartmentId: 'dept-0' }),
      'departmentIds',
    );
  });

  it('departmentIds 边界 500 个通过', async () => {
    const departmentIds = Array.from({ length: 500 }, (_, index) => `dept-${index}`);
    await expectValid(
      new EmployeeModel({ ...validEmployee(), departmentIds, primaryDepartmentId: 'dept-0' }),
    );
  });

  it('positionIds 超过 200 个被拒绝，200 个通过', async () => {
    const tooMany = Array.from({ length: 201 }, (_, index) => `pos-${index}`);
    await expectInvalid(
      new EmployeeModel({ ...validEmployee(), positionIds: tooMany }),
      'positionIds',
    );
    const atLimit = Array.from({ length: 200 }, (_, index) => `pos-${index}`);
    await expectValid(new EmployeeModel({ ...validEmployee(), positionIds: atLimit }));
  });

  it('数组元素超长（>128）被拒绝', async () => {
    await expectInvalid(
      new EmployeeModel({ ...validEmployee(), departmentIds: ['d'.repeat(129)] }),
      'departmentIds',
    );
  });

  it('数组元素必须非空且不能重复', async () => {
    await expectInvalid(
      new EmployeeModel({ ...validEmployee(), departmentIds: ['dept-1', ''] }),
      'departmentIds',
    );
    await expectInvalid(
      new EmployeeModel({ ...validEmployee(), departmentIds: ['dept-1', 'dept-1'] }),
      'departmentIds',
    );
  });

  it('primaryDepartmentId 不属于 departmentIds 被拒绝', async () => {
    await expectInvalid(
      new EmployeeModel({ ...validEmployee(), primaryDepartmentId: 'dept-other' }),
      'primaryDepartmentId',
    );
  });

  it('status 仅允许 probation/active/suspended/terminated', async () => {
    await expectInvalid(new EmployeeModel({ ...validEmployee(), status: 'hired' }), 'status');
    for (const status of ['probation', 'active', 'suspended', 'terminated'] as const) {
      await expectValid(new EmployeeModel({ ...validEmployee(), status }));
    }
  });
});

describe('Person、Employment 与工号序列 Schema 校验', () => {
  it('只允许 Person 引用核验证据，不接受非法状态', async () => {
    await expectValid(new PersonModel(validPerson()));
    await expectInvalid(new PersonModel({ ...validPerson(), status: 'merged' }), 'status');
  });

  it('Employment 必须具备来源、合同证据和合法状态', async () => {
    await expectValid(new EmploymentModel(validEmployment()));
    await expectInvalid(
      new EmploymentModel({ ...validEmployment(), signedEvidenceId: undefined }),
      'signedEvidenceId',
    );
    await expectInvalid(
      new EmploymentModel({ ...validEmployment(), status: 'terminated' }),
      'status',
    );
  });

  it('年度工号序列只接受正整数与受控年份', async () => {
    await expectValid(new EmployeeNumberSequenceModel({
      tenantId: 'tenant-a', year: 2026, lastValue: 1,
    }));
    await expectInvalid(new EmployeeNumberSequenceModel({
      tenantId: 'tenant-a', year: 2026, lastValue: 0,
    }), 'lastValue');
    await expectInvalid(new EmployeeNumberSequenceModel({
      tenantId: 'tenant-a', year: 1999, lastValue: 1,
    }), 'year');
  });

  it('关键幂等和在职唯一索引全部存在', () => {
    expect(OrgPersonRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, sourceCandidateId: 1 }, expect.objectContaining({ unique: true }),
    ]);
    expect(OrgPersonRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, identityEvidenceId: 1 }, expect.objectContaining({ unique: true }),
    ]);
    expect(OrgEmploymentRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, onboardingInstanceId: 1 }, expect.objectContaining({ unique: true }),
    ]);
    const activeEmploymentIndex = OrgEmploymentRecordSchema.indexes().find(
      ([fields]) => JSON.stringify(fields) === JSON.stringify({ tenantId: 1, personId: 1 }),
    );
    expect(activeEmploymentIndex?.[1]).toMatchObject({
      unique: true,
      partialFilterExpression: { effectiveTo: null },
    });
  });
});

describe('OrgJobLevelRecordSchema 校验', () => {
  it('合法文档通过校验，rank 边界 1/30 均通过', async () => {
    await expectValid(new JobLevelModel(validJobLevel()));
    await expectValid(new JobLevelModel({ ...validJobLevel(), rank: 1 }));
    await expectValid(new JobLevelModel({ ...validJobLevel(), rank: 30 }));
  });

  it('rank 超出 1..30 或非整数被拒绝', async () => {
    await expectInvalid(new JobLevelModel({ ...validJobLevel(), rank: 0 }), 'rank');
    await expectInvalid(new JobLevelModel({ ...validJobLevel(), rank: 31 }), 'rank');
    await expectInvalid(new JobLevelModel({ ...validJobLevel(), rank: 5.5 }), 'rank');
  });

  it('track 仅允许 professional/management', async () => {
    await expectInvalid(new JobLevelModel({ ...validJobLevel(), track: 'sales' }), 'track');
    await expectValid(new JobLevelModel({ ...validJobLevel(), track: 'management' }));
  });
});

describe('OrgPositionRecordSchema 校验', () => {
  it('合法文档通过校验，非法 status 被拒绝', async () => {
    await expectValid(
      new PositionModel({
        id: 'pos-1',
        tenantId: 'tenant-a',
        code: 'FE',
        name: '前端工程师',
        status: 'active',
        version: 1,
      }),
    );
    await expectInvalid(
      new PositionModel({
        id: 'pos-1',
        tenantId: 'tenant-a',
        code: 'FE',
        name: '前端工程师',
        status: 'archived',
        version: 1,
      }),
      'status',
    );
  });
});

describe('OutboxRecordSchema 校验', () => {
  it('合法文档通过校验', async () => {
    await expectValid(new OutboxModel(validOutbox()));
  });

  it('eventId 必须为 ULID 形态', async () => {
    await expectInvalid(new OutboxModel({ ...validOutbox(), eventId: 'not-a-ulid' }), 'eventId');
    await expectInvalid(
      new OutboxModel({ ...validOutbox(), eventId: '01J8ZQK7V0A2M4N6P8R0T2W4UI' }),
      'eventId',
    );
    await expectInvalid(
      new OutboxModel({ ...validOutbox(), eventId: '81J8ZQK7V0A2M4N6P8R0T2W4Y6' }),
      'eventId',
    );
  });

  it('envelope 命中敏感键名（token/secret 等）被拒绝', async () => {
    await expectInvalid(
      new OutboxModel({ ...validOutbox(), envelope: { accessToken: 'x' } }),
      'envelope',
    );
    await expectInvalid(
      new OutboxModel({ ...validOutbox(), envelope: { payload: { upstreamSecret: 'y' } } }),
      'envelope',
    );
    await expectInvalid(
      new OutboxModel({ ...validOutbox(), envelope: { payload: { mobile: '13800000000' } } }),
      'envelope',
    );
  });

  it('attempts 必须为非负整数', async () => {
    await expectInvalid(new OutboxModel({ ...validOutbox(), attempts: -1 }), 'attempts');
    await expectInvalid(new OutboxModel({ ...validOutbox(), attempts: 1.5 }), 'attempts');
  });

  it('status 仅允许 pending/dispatching/dispatched/dead', async () => {
    await expectInvalid(new OutboxModel({ ...validOutbox(), status: 'sent' }), 'status');
  });
});

describe('Schema 索引规范', () => {
  const allSchemas: ReadonlyArray<[string, Schema]> = [
    ['org_departments', OrgDepartmentRecordSchema],
    ['org_employees', OrgEmployeeRecordSchema],
    ['org_positions', OrgPositionRecordSchema],
    ['org_job_levels', OrgJobLevelRecordSchema],
    ['integration_outbox', OutboxRecordSchema],
  ];

  it('每个集合均有 tenantId+id 唯一索引', () => {
    for (const [name, schema] of allSchemas) {
      if (name === 'integration_outbox') {
        continue;
      }
      const hit = schema
        .indexes()
        .some(
          ([keys, options]) =>
            options?.unique === true &&
            JSON.stringify(keys) === JSON.stringify({ tenantId: 1, id: 1 }),
        );
      expect(hit, `${name} 缺少 tenantId+id 唯一索引`).toBe(true);
    }
  });

  it('唯一索引均以 tenantId 为前缀（Outbox 全局 eventId 除外）', () => {
    for (const [name, schema] of allSchemas) {
      for (const [keys, options] of schema.indexes()) {
        if (options?.unique !== true) {
          continue;
        }
        const firstKey = Object.keys(keys)[0];
        if (name === 'integration_outbox' && firstKey === 'eventId') {
          continue;
        }
        expect(firstKey, `${name} 的唯一索引必须以 tenantId 开头`).toBe('tenantId');
      }
    }
  });

  it('部门 parentId、员工部门/状态复合索引存在且以 tenantId 开头', () => {
    const indexKeysOf = (schema: Schema): string[] =>
      schema.indexes().map(([keys]) => JSON.stringify(keys));
    expect(indexKeysOf(OrgDepartmentRecordSchema)).toContain(
      JSON.stringify({ tenantId: 1, parentId: 1, sortOrder: 1 }),
    );
    expect(indexKeysOf(OrgEmployeeRecordSchema)).toEqual(
      expect.arrayContaining([
        JSON.stringify({ tenantId: 1, departmentIds: 1 }),
        JSON.stringify({ tenantId: 1, primaryDepartmentId: 1 }),
        JSON.stringify({ tenantId: 1, status: 1 }),
      ]),
    );
  });

  it('Outbox 事件幂等唯一索引以 tenantId 开头', () => {
    const hit = OutboxRecordSchema.indexes().some(
      ([keys, options]) =>
        options?.unique === true &&
        JSON.stringify(keys) ===
          JSON.stringify({
            tenantId: 1,
            aggregateType: 1,
            aggregateId: 1,
            aggregateVersion: 1,
            eventType: 1,
          }),
    );
    expect(hit).toBe(true);
  });

  it('Outbox relay 索引与 dispatched TTL 部分索引配置正确', () => {
    const relay = OutboxRecordSchema.indexes().find(
      ([keys]) =>
        JSON.stringify(keys) === JSON.stringify({ status: 1, nextAttemptAt: 1, createdAt: 1 }),
    );
    expect(relay, '缺少 status+nextAttemptAt+createdAt relay 索引').toBeDefined();

    const ttl = OutboxRecordSchema.indexes().find(
      ([keys]) => JSON.stringify(keys) === JSON.stringify({ dispatchedAt: 1 }),
    );
    expect(ttl, '缺少 dispatchedAt TTL 索引').toBeDefined();
    const ttlOptions = ttl?.[1];
    expect(ttlOptions?.expireAfterSeconds).toBe(30 * 24 * 60 * 60);
    expect(ttlOptions?.partialFilterExpression).toEqual({ status: 'dispatched' });
  });

  it('模型元信息：集合名正确', () => {
    const expectations: ReadonlyArray<[Model<unknown>, string]> = [
      [DepartmentModel as Model<unknown>, 'org_departments'],
      [EmployeeModel as Model<unknown>, 'org_employees'],
      [PositionModel as Model<unknown>, 'org_positions'],
      [JobLevelModel as Model<unknown>, 'org_job_levels'],
      [OutboxModel as Model<unknown>, 'integration_outbox'],
    ];
    for (const [model, collection] of expectations) {
      expect(model.collection.name).toBe(collection);
    }
  });
});
