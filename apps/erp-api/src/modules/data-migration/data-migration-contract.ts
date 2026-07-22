/** 迁移范围与实体白名单的唯一事实源；API、账本、CLI 与 MCP 必须复用。 */
export const DATA_MIGRATION_SCOPE_ENTITIES = Object.freeze({
  org_reference: Object.freeze([
    'org.department',
    'org.position',
    'org.job_level',
  ]),
  org_workforce: Object.freeze(['org.employee']),
  org_employment: Object.freeze(['org.employment']),
} as const);

export type DataMigrationScope = keyof typeof DATA_MIGRATION_SCOPE_ENTITIES;
export type DataMigrationEntityType =
  (typeof DATA_MIGRATION_SCOPE_ENTITIES)[DataMigrationScope][number];

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
  });

/** 失败关闭地校验实体是否属于本批次范围。 */
export function isEntityInMigrationScope(
  scope: DataMigrationScope,
  entityType: DataMigrationEntityType,
): boolean {
  return DATA_MIGRATION_SCOPE_ENTITIES[scope].includes(entityType);
}
