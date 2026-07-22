/** 迁移范围与实体白名单的唯一事实源；API、账本、CLI 与 MCP 必须复用。 */
export const DATA_MIGRATION_SCOPE_ENTITIES = Object.freeze({
  org_reference: Object.freeze([
    'org.department',
    'org.position',
    'org.job_level',
  ]),
  org_workforce: Object.freeze(['org.employee']),
  org_employment: Object.freeze(['org.employment']),
  approval_templates: Object.freeze(['approval.template']),
  approval_history: Object.freeze(['approval.history']),
  approval_active_instances: Object.freeze(['approval.instance']),
  recruitment_reference: Object.freeze([
    'recruitment.requisition',
    'recruitment.position',
  ]),
  recruitment_candidates: Object.freeze(['recruitment.candidate']),
  recruitment_applications: Object.freeze(['recruitment.application']),
  recruitment_interviews: Object.freeze(['recruitment.interview']),
  recruitment_offers: Object.freeze(['recruitment.offer']),
  attendance_source_facts: Object.freeze(['attendance.source_fact']),
  attendance_corrections: Object.freeze(['attendance.correction']),
  attendance_monthly_snapshots: Object.freeze(['attendance.monthly_snapshot']),
  payroll_rule_packs: Object.freeze(['payroll.rule_pack']),
  payroll_compensation_profiles: Object.freeze(['payroll.compensation_profile']),
} as const);

export type DataMigrationScope = keyof typeof DATA_MIGRATION_SCOPE_ENTITIES;
export type DataMigrationEntityType =
  (typeof DATA_MIGRATION_SCOPE_ENTITIES)[DataMigrationScope][number];
export type DataMigrationDataClassification = 'L3' | 'L4';

export const DATA_MIGRATION_SCOPES = Object.freeze(
  Object.keys(DATA_MIGRATION_SCOPE_ENTITIES) as DataMigrationScope[],
);

export const DATA_MIGRATION_ENTITY_TYPES = Object.freeze(
  Object.values(DATA_MIGRATION_SCOPE_ENTITIES).flat(),
);

/** 每个迁移范围除执行权外还必须持有目标领域写权限。 */
export const DATA_MIGRATION_SCOPE_WRITE_SCOPE: Readonly<Record<DataMigrationScope, string>> =
  Object.freeze({
    org_reference: 'erp:org:master:write',
    org_workforce: 'erp:org:master:write',
    org_employment: 'erp:org:master:write',
    approval_templates: 'erp:approval:migration:write',
    approval_history: 'erp:approval:migration:write',
    approval_active_instances: 'erp:approval:migration:write',
    recruitment_reference: 'erp:recruitment:migration:write',
    recruitment_candidates: 'erp:recruitment:migration:write',
    recruitment_applications: 'erp:recruitment:migration:write',
    recruitment_interviews: 'erp:recruitment:migration:write',
    recruitment_offers: 'erp:recruitment:migration:write',
    attendance_source_facts: 'erp:attendance:migration:write',
    attendance_corrections: 'erp:attendance:migration:write',
    attendance_monthly_snapshots: 'erp:attendance:migration:write',
    payroll_rule_packs: 'erp:payroll:migration:write',
    payroll_compensation_profiles: 'erp:payroll:migration:write',
  });

/** 附件分级只由服务端 Scope 决定，禁止来源包或客户端降级。 */
export const DATA_MIGRATION_SCOPE_CLASSIFICATION:
Readonly<Record<DataMigrationScope, DataMigrationDataClassification>> = Object.freeze({
  org_reference: 'L3',
  org_workforce: 'L3',
  org_employment: 'L3',
  approval_templates: 'L3',
  approval_history: 'L3',
  approval_active_instances: 'L3',
  recruitment_reference: 'L3',
  recruitment_candidates: 'L3',
  recruitment_applications: 'L3',
  recruitment_interviews: 'L3',
  recruitment_offers: 'L4',
  attendance_source_facts: 'L4',
  attendance_corrections: 'L4',
  attendance_monthly_snapshots: 'L4',
  payroll_rule_packs: 'L3',
  payroll_compensation_profiles: 'L4',
});

/** 失败关闭地校验实体是否属于本批次范围。 */
export function isEntityInMigrationScope(
  scope: DataMigrationScope,
  entityType: DataMigrationEntityType,
): boolean {
  return DATA_MIGRATION_SCOPE_ENTITIES[scope].includes(entityType);
}
