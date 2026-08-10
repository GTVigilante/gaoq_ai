export type ViewType = 'grid' | 'kanban' | 'calendar' | 'gallery' | 'gantt' | 'form' | 'dashboard';

export interface BaseFieldOption {
  readonly value: string;
  readonly label: string;
  readonly color?: string;
}

export interface BaseField {
  readonly key: string;
  readonly label: string;
  readonly type: string;
  readonly sensitivity: string;
  readonly required?: boolean;
  readonly placeholder?: string;
  readonly options?: readonly BaseFieldOption[];
}

export interface BaseDefinition {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: string;
  readonly revision: number;
  readonly items: readonly ({ readonly kind: 'field'; readonly field: BaseField } | { readonly kind: 'layout' })[];
}

export type DatasetRef =
  | { readonly kind: 'native'; readonly datasetId: string; readonly schemaRevision: number }
  | { readonly kind: 'external'; readonly system: string; readonly objectType: string; readonly schemaVersion: string };

export interface DatasetSchema {
  readonly ref: DatasetRef;
  readonly name: string;
  readonly primaryFieldKey: string;
  readonly fields: readonly (BaseField & {
    readonly readOnly: boolean;
    readonly availability: 'generic' | 'dedicated_only';
  })[];
  readonly capabilities: {
    readonly resolve: true;
    readonly snapshot: boolean;
    readonly query: 'none' | 'exact';
    readonly commands: readonly string[];
  };
}

export interface BaseFilterCondition {
  readonly fieldKey: string;
  readonly operator: 'eq' | 'ne' | 'contains' | 'not_contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'is_empty' | 'is_not_empty';
  readonly value?: string | number | boolean | null;
}

export interface BaseView {
  readonly id: string;
  readonly tableId: string;
  readonly name: string;
  readonly type: ViewType;
  readonly config: {
    readonly visibleFieldKeys: readonly string[];
    readonly frozenFieldCount: number;
    readonly rowHeight: 'compact' | 'medium' | 'tall';
    readonly sorts: readonly { readonly fieldKey: string; readonly direction: 'asc' | 'desc' }[];
    readonly groups: readonly string[];
    readonly filter?: { readonly mode: 'all' | 'any'; readonly conditions: readonly BaseFilterCondition[] };
  };
}

export interface MultidimensionalBase {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly version: number;
  readonly tables: readonly BaseTable[];
  readonly views: readonly BaseView[];
  readonly automations: readonly {
    readonly id: string;
    readonly name: string;
    readonly enabled: boolean;
    readonly trigger:
      | { readonly type: 'record_created'; readonly tableId: string }
      | { readonly type: 'record_updated'; readonly tableId: string; readonly watchedFieldKeys: readonly string[] }
      | { readonly type: 'scheduled'; readonly tableId: string; readonly intervalMinutes: number }
      | { readonly type: 'webhook'; readonly tableId: string; readonly webhookCode: string }
      | { readonly type: 'manual'; readonly tableId: string };
    readonly actions: readonly (
      | { readonly type: 'notify'; readonly channel: 'in_app' | 'email'; readonly recipientFieldKey?: string; readonly templateCode: string }
      | { readonly type: 'create_record'; readonly targetTableId: string; readonly fieldMapping: Readonly<Record<string, string>> }
      | { readonly type: 'update_record'; readonly fieldMapping: Readonly<Record<string, string>> }
      | { readonly type: 'start_approval' }
      | { readonly type: 'connector_call'; readonly connectorId: string; readonly operation: string }
    )[];
  }[];
}

export type BaseTable =
  | { readonly kind: 'native'; readonly formId: string; readonly name: string; readonly primaryFieldKey: string; readonly position: number }
  | { readonly kind: 'external'; readonly id: string; readonly dataset: Extract<DatasetRef, { readonly kind: 'external' }>; readonly name: string; readonly primaryFieldKey: string; readonly position: number };

export interface BaseRecordRow {
  readonly id: string;
  readonly version: number | string;
  readonly values: Readonly<Record<string, unknown>>;
  readonly updatedAt: string;
}

export interface ResolvedDatasetRecord {
  readonly ref: { readonly dataset: DatasetRef; readonly recordId: string; readonly version: string };
  readonly values: Readonly<Record<string, unknown>>;
  readonly observedAt: string;
}

export function datasetKey(ref: DatasetRef): string {
  return ref.kind === 'native'
    ? `native:${ref.datasetId}:${ref.schemaRevision}`
    : `external:${ref.system}:${ref.objectType}:${ref.schemaVersion}`;
}

export function baseTableId(table: BaseTable): string {
  return table.kind === 'native' ? table.formId : table.id;
}
