import type { DatasetRecordRef, DatasetRef, DatasetSchema, QueryDatasetRecordsInput } from '../domain/dataset-runtime.js';

export interface AdapterDatasetRecord {
  readonly dataset: DatasetRef;
  readonly recordId: string;
  readonly version: string;
  readonly values: Readonly<Record<string, unknown>>;
  readonly observedAt: string;
}

/** 数据源 Adapter seam；生产与测试实现都必须返回可被运行时反向绑定的普通对象。 */
export abstract class DatasetAdapter {
  abstract readonly code: string;
  abstract readonly requiredScope: string;
  abstract accepts(ref: DatasetRef): boolean;
  abstract catalog(): Promise<readonly DatasetSchema[]>;
  abstract describe(ref: DatasetRef): Promise<DatasetSchema>;
  abstract resolve(ref: DatasetRecordRef): Promise<AdapterDatasetRecord>;
  abstract query(input: QueryDatasetRecordsInput): Promise<readonly AdapterDatasetRecord[]>;
}
