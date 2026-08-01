import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

/** 标识类字符串最大长度（id、tenantId、code、外键引用等）。 */
const MAX_ID_LENGTH = 128;
/** 名称类字符串最大长度。 */
const MAX_NAME_LENGTH = 256;
/** 员工挂靠部门数下限。 */
const MIN_DEPARTMENT_COUNT = 1;
/** 员工挂靠部门数上限。 */
const MAX_DEPARTMENT_COUNT = 500;
/** 员工挂靠岗位数上限。 */
const MAX_POSITION_COUNT = 200;
/** 职级档位下限。 */
const MIN_RANK = 1;
/** 职级档位上限。 */
const MAX_RANK = 30;

const ORG_ID_ARRAY_ELEMENT = {
  type: String,
  required: true,
  trim: true,
  minlength: 1,
  maxlength: MAX_ID_LENGTH,
} as const;

const hasUniqueElements = (value: string[]): boolean =>
  new Set(value).size === value.length;

/** 非负整数校验器（用于 sortOrder、attempts 等）。 */
const isNonNegativeInteger = (value: number): boolean =>
  Number.isInteger(value) && value >= 0;

/** 大于等于 1 的整数校验器（用于乐观锁版本号）。 */
const isPositiveInteger = (value: number): boolean =>
  Number.isInteger(value) && value >= 1;

/** 部门状态。 */
export type OrgDepartmentStatus = 'active' | 'inactive';

/** 员工在职状态。 */
export type OrgEmployeeStatus = 'probation' | 'active' | 'suspended' | 'terminated';

/** 劳动关系状态。 */
export type OrgEmploymentStatus = 'probation' | 'active' | 'suspended' | 'resigned';

/** 岗位状态。 */
export type OrgPositionStatus = 'active' | 'inactive';

/** 职级序列。 */
export type OrgJobLevelTrack = 'professional' | 'management';

/**
 * 部门持久化记录（集合 org_departments）。
 * 唯一性：tenantId+id、tenantId+code；parentId 建立父子查询复合索引。
 */
@Schema({ collection: 'org_departments', timestamps: true, versionKey: false, id: false })
export class OrgDepartmentRecord {
  /** 部门标识，租户内唯一，创建后不可变。 */
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  id!: string;

  /** 租户标识，来自已验证身份上下文，创建后不可变。 */
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  tenantId!: string;

  /** 租户内唯一编码。 */
  @Prop({ type: String, required: true, maxlength: MAX_ID_LENGTH })
  code!: string;

  /** 部门名称。 */
  @Prop({ type: String, required: true, maxlength: MAX_NAME_LENGTH })
  name!: string;

  /** 部门状态。 */
  @Prop({ type: String, enum: ['active', 'inactive'], required: true, default: 'active' })
  status!: OrgDepartmentStatus;

  /** 上级部门标识；根部门为 null。 */
  @Prop({ type: String, default: null, maxlength: MAX_ID_LENGTH })
  parentId!: string | null;

  /** 部门负责人（员工标识）；未任命为 null。 */
  @Prop({ type: String, default: null, maxlength: MAX_ID_LENGTH })
  managerId!: string | null;

  /** 同级排序序号，非负整数。 */
  @Prop({
    type: Number,
    required: true,
    default: 0,
    validate: { validator: isNonNegativeInteger, message: 'sortOrder 必须为非负整数' },
  })
  sortOrder!: number;

  /** 乐观锁版本号，从 1 开始递增。 */
  @Prop({
    type: Number,
    required: true,
    default: 1,
    validate: { validator: isPositiveInteger, message: 'version 必须为 >=1 的整数' },
  })
  version!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export type OrgDepartmentDocument = HydratedDocument<OrgDepartmentRecord>;
export const OrgDepartmentRecordSchema = SchemaFactory.createForClass(OrgDepartmentRecord);

OrgDepartmentRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
OrgDepartmentRecordSchema.index({ tenantId: 1, code: 1 }, { unique: true });
/** 按上级部门拉取有序子部门列表。 */
OrgDepartmentRecordSchema.index({ tenantId: 1, parentId: 1, sortOrder: 1 });
/** 按状态过滤部门列表。 */
OrgDepartmentRecordSchema.index({ tenantId: 1, status: 1 });

/**
 * 员工持久化记录（集合 org_employees）。
 * 唯一性：tenantId+id、tenantId+employeeNo；部门与状态建立查询复合索引。
 * 注意：主数据仅含组织视图字段，禁止写入手机号、身份证、薪资等敏感字段。
 */
@Schema({ collection: 'org_employees', timestamps: true, versionKey: false, id: false })
export class OrgEmployeeRecord {
  /** 员工标识，租户内唯一，创建后不可变。 */
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  id!: string;

  /** 租户标识，来自已验证身份上下文，创建后不可变。 */
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  tenantId!: string;

  /** 工号，租户内唯一。 */
  @Prop({ type: String, required: true, maxlength: MAX_ID_LENGTH })
  employeeNo!: string;

  /** 展示姓名。 */
  @Prop({ type: String, required: true, maxlength: MAX_NAME_LENGTH })
  displayName!: string;

  /** 在职状态。 */
  @Prop({
    type: String,
    enum: ['probation', 'active', 'suspended', 'terminated'],
    required: true,
    default: 'probation',
  })
  status!: OrgEmployeeStatus;

  /** 所属部门集合，1..500 个。 */
  @Prop({
    type: [ORG_ID_ARRAY_ELEMENT],
    required: true,
    validate: {
      validator: (value: string[]): boolean =>
        Array.isArray(value) &&
        value.length >= MIN_DEPARTMENT_COUNT &&
        value.length <= MAX_DEPARTMENT_COUNT &&
        hasUniqueElements(value),
      message: `departmentIds 数量必须在 ${MIN_DEPARTMENT_COUNT}..${MAX_DEPARTMENT_COUNT} 之间`,
    },
  })
  departmentIds!: string[];

  /** 主部门标识，必须属于 departmentIds（一致性由 schema pre-validate 保证）。 */
  @Prop({ type: String, required: true, maxlength: MAX_ID_LENGTH })
  primaryDepartmentId!: string;

  /** 兼任岗位集合，0..200 个。 */
  @Prop({
    type: [ORG_ID_ARRAY_ELEMENT],
    required: true,
    default: [],
    validate: {
      validator: (value: string[]): boolean =>
        Array.isArray(value) && value.length <= MAX_POSITION_COUNT && hasUniqueElements(value),
      message: `positionIds 数量不能超过 ${MAX_POSITION_COUNT}`,
    },
  })
  positionIds!: string[];

  /** 职级标识；未定级为 null。 */
  @Prop({ type: String, default: null, maxlength: MAX_ID_LENGTH })
  jobLevelId!: string | null;

  /** 乐观锁版本号，从 1 开始递增。 */
  @Prop({
    type: Number,
    required: true,
    default: 1,
    validate: { validator: isPositiveInteger, message: 'version 必须为 >=1 的整数' },
  })
  version!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export type OrgEmployeeDocument = HydratedDocument<OrgEmployeeRecord>;
export const OrgEmployeeRecordSchema = SchemaFactory.createForClass(OrgEmployeeRecord);

/** 主部门必须包含在 departmentIds 中，保持引用一致性。 */
OrgEmployeeRecordSchema.pre('validate', function () {
  const doc = this as OrgEmployeeRecord;
  if (Array.isArray(doc.departmentIds) && !doc.departmentIds.includes(doc.primaryDepartmentId)) {
    throw new Error('primaryDepartmentId 必须属于 departmentIds');
  }
});

OrgEmployeeRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
OrgEmployeeRecordSchema.index({ tenantId: 1, employeeNo: 1 }, { unique: true });
/** 按部门检索成员（多键复合索引）。 */
OrgEmployeeRecordSchema.index({ tenantId: 1, departmentIds: 1 });
/** 按主部门检索成员。 */
OrgEmployeeRecordSchema.index({ tenantId: 1, primaryDepartmentId: 1 });
/** 按在职状态检索员工。 */
OrgEmployeeRecordSchema.index({ tenantId: 1, status: 1 });

/**
 * 自然人主数据（集合 org_persons）。
 * 只持有来源和核验证据引用，不保存证件号、手机号、邮箱或材料原文。
 */
@Schema({ collection: 'org_persons', timestamps: true, versionKey: false, id: false })
export class OrgPersonRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  id!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  tenantId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  sourceCandidateId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  identityEvidenceId!: string;

  @Prop({ type: String, default: null, maxlength: MAX_ID_LENGTH })
  birthdayEvidenceId!: string | null;

  @Prop({
    type: [String],
    default: [],
    validate: {
      validator: (value: string[]): boolean =>
        value.length <= 5 &&
        new Set(value).size === value.length &&
        value.every((item) =>
          /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.[A-Za-z0-9_-]{43}$/.test(item),
        ),
      message: '生日盲索引必须是去重的受控 HMAC 指纹',
    },
  })
  birthdayBlindIndexes!: string[];

  @Prop({ type: Date, default: null })
  birthdayAttestedAt!: Date | null;

  @Prop({ type: String, enum: ['active'], required: true })
  status!: 'active';

  @Prop({ type: Number, required: true, validate: { validator: isPositiveInteger } })
  version!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export type OrgPersonDocument = HydratedDocument<OrgPersonRecord>;
export const OrgPersonRecordSchema = SchemaFactory.createForClass(OrgPersonRecord);
OrgPersonRecordSchema.pre('validate', function validateBirthdayProjection() {
  const absent =
    this.birthdayEvidenceId === null &&
    this.birthdayAttestedAt === null &&
    this.birthdayBlindIndexes.length === 0;
  const attested =
    this.birthdayEvidenceId !== null &&
    this.birthdayAttestedAt instanceof Date &&
    this.birthdayBlindIndexes.length >= 1 &&
    this.birthdayBlindIndexes.length <= 5;
  if (!absent && !attested) {
    this.invalidate('birthdayEvidenceId', '生日证明、时间和盲索引必须成套存在');
  }
});
OrgPersonRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
OrgPersonRecordSchema.index({ tenantId: 1, sourceCandidateId: 1 }, { unique: true });
OrgPersonRecordSchema.index({ tenantId: 1, identityEvidenceId: 1 }, { unique: true });
OrgPersonRecordSchema.index(
  { tenantId: 1, birthdayEvidenceId: 1 },
  {
    unique: true,
    partialFilterExpression: { birthdayEvidenceId: { $type: 'string' } },
  },
);
OrgPersonRecordSchema.index(
  { tenantId: 1, birthdayBlindIndexes: 1 },
  { partialFilterExpression: { birthdayEvidenceId: { $type: 'string' } } },
);

/** 劳动关系记录（集合 org_employments），与员工组织视图分离。 */
@Schema({ collection: 'org_employments', timestamps: true, versionKey: false, id: false })
export class OrgEmploymentRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  id!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  tenantId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  personId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  employeeId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  onboardingInstanceId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  onboardingCompletionEvidenceId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  offerId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  signedEvidenceId!: string;

  @Prop({ type: String, default: null, maxlength: MAX_ID_LENGTH })
  terminationCareCaseId!: string | null;

  @Prop({ type: String, default: null, maxlength: MAX_ID_LENGTH })
  terminationExecutionEvidenceId!: string | null;

  @Prop({ type: String, default: null, maxlength: MAX_ID_LENGTH })
  terminationEvidenceId!: string | null;

  @Prop({
    type: String, enum: ['probation', 'active', 'suspended', 'resigned'], required: true,
  })
  status!: OrgEmploymentStatus;

  @Prop({ type: String, required: true, immutable: true, match: /^\d{4}-\d{2}-\d{2}$/ })
  effectiveFrom!: string;

  @Prop({ type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ })
  effectiveTo!: string | null;

  @Prop({ type: Number, required: true, validate: { validator: isPositiveInteger } })
  version!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export type OrgEmploymentDocument = HydratedDocument<OrgEmploymentRecord>;
export const OrgEmploymentRecordSchema = SchemaFactory.createForClass(OrgEmploymentRecord);
OrgEmploymentRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
OrgEmploymentRecordSchema.index({ tenantId: 1, onboardingInstanceId: 1 }, { unique: true });
OrgEmploymentRecordSchema.index({ tenantId: 1, employeeId: 1, effectiveFrom: -1 });
OrgEmploymentRecordSchema.index(
  { tenantId: 1, employeeId: 1 },
  { unique: true, partialFilterExpression: { effectiveTo: null } },
);
OrgEmploymentRecordSchema.index(
  { tenantId: 1, terminationCareCaseId: 1 },
  { unique: true, partialFilterExpression: { terminationCareCaseId: { $type: 'string' } } },
);
OrgEmploymentRecordSchema.index(
  { tenantId: 1, personId: 1 },
  { unique: true, partialFilterExpression: { effectiveTo: null } },
);

/** 租户年度工号序列，仅由组织应用服务在事务内原子递增。 */
@Schema({ collection: 'org_employee_number_sequences', timestamps: true, versionKey: false, id: false })
export class OrgEmployeeNumberSequenceRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  tenantId!: string;

  @Prop({ type: Number, required: true, immutable: true, min: 2000, max: 2200 })
  year!: number;

  @Prop({ type: Number, required: true, min: 1, validate: { validator: isPositiveInteger } })
  lastValue!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export type OrgEmployeeNumberSequenceDocument = HydratedDocument<OrgEmployeeNumberSequenceRecord>;
export const OrgEmployeeNumberSequenceRecordSchema = SchemaFactory.createForClass(
  OrgEmployeeNumberSequenceRecord,
);
OrgEmployeeNumberSequenceRecordSchema.index({ tenantId: 1, year: 1 }, { unique: true });

/**
 * 岗位持久化记录（集合 org_positions）。
 * 唯一性：tenantId+id、tenantId+code。
 */
@Schema({ collection: 'org_positions', timestamps: true, versionKey: false, id: false })
export class OrgPositionRecord {
  /** 岗位标识，租户内唯一，创建后不可变。 */
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  id!: string;

  /** 租户标识，来自已验证身份上下文，创建后不可变。 */
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  tenantId!: string;

  /** 租户内唯一编码。 */
  @Prop({ type: String, required: true, maxlength: MAX_ID_LENGTH })
  code!: string;

  /** 岗位名称。 */
  @Prop({ type: String, required: true, maxlength: MAX_NAME_LENGTH })
  name!: string;

  /** 岗位状态。 */
  @Prop({ type: String, enum: ['active', 'inactive'], required: true, default: 'active' })
  status!: OrgPositionStatus;

  /** 乐观锁版本号，从 1 开始递增。 */
  @Prop({
    type: Number,
    required: true,
    default: 1,
    validate: { validator: isPositiveInteger, message: 'version 必须为 >=1 的整数' },
  })
  version!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export type OrgPositionDocument = HydratedDocument<OrgPositionRecord>;
export const OrgPositionRecordSchema = SchemaFactory.createForClass(OrgPositionRecord);

OrgPositionRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
OrgPositionRecordSchema.index({ tenantId: 1, code: 1 }, { unique: true });

/**
 * 职级持久化记录（集合 org_job_levels）。
 * 唯一性：tenantId+id、tenantId+code；track+rank 建立序列档位查询索引。
 */
@Schema({ collection: 'org_job_levels', timestamps: true, versionKey: false, id: false })
export class OrgJobLevelRecord {
  /** 职级标识，租户内唯一，创建后不可变。 */
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  id!: string;

  /** 租户标识，来自已验证身份上下文，创建后不可变。 */
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  tenantId!: string;

  /** 租户内唯一编码。 */
  @Prop({ type: String, required: true, maxlength: MAX_ID_LENGTH })
  code!: string;

  /** 职级名称。 */
  @Prop({ type: String, required: true, maxlength: MAX_NAME_LENGTH })
  name!: string;

  /** 职级序列：专业序列 / 管理序列。 */
  @Prop({ type: String, enum: ['professional', 'management'], required: true })
  track!: OrgJobLevelTrack;

  /** 档位，1..30 的整数。 */
  @Prop({
    type: Number,
    required: true,
    validate: {
      validator: (value: number): boolean =>
        Number.isInteger(value) && value >= MIN_RANK && value <= MAX_RANK,
      message: `rank 必须为 ${MIN_RANK}..${MAX_RANK} 的整数`,
    },
  })
  rank!: number;

  /** 乐观锁版本号，从 1 开始递增。 */
  @Prop({
    type: Number,
    required: true,
    default: 1,
    validate: { validator: isPositiveInteger, message: 'version 必须为 >=1 的整数' },
  })
  version!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export type OrgJobLevelDocument = HydratedDocument<OrgJobLevelRecord>;
export const OrgJobLevelRecordSchema = SchemaFactory.createForClass(OrgJobLevelRecord);

OrgJobLevelRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
OrgJobLevelRecordSchema.index({ tenantId: 1, code: 1 }, { unique: true });
/** 按序列与档位检索职级。 */
OrgJobLevelRecordSchema.index({ tenantId: 1, track: 1, rank: 1 });
