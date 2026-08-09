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
  readonly items: readonly ({ readonly kind: 'field'; readonly field: BaseField } | { readonly kind: 'layout' })[];
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
  readonly tables: readonly { readonly formId: string; readonly name: string; readonly primaryFieldKey: string; readonly position: number }[];
  readonly views: readonly BaseView[];
  readonly automations: readonly {
    readonly id: string;
    readonly name: string;
    readonly enabled: boolean;
    readonly trigger: { readonly type: string; readonly tableId: string };
    readonly actions: readonly { readonly type: string }[];
  }[];
}

export interface BaseRecordRow {
  readonly id: string;
  readonly version: number;
  readonly values: Readonly<Record<string, unknown>>;
  readonly updatedAt: string;
}
