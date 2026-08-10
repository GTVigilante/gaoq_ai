import { BadRequestException } from '@nestjs/common';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import { z } from 'zod';

const CODE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export const nativeDatasetRefSchema = z.object({
  kind: z.literal('native'),
  datasetId: z.string().regex(ULID_PATTERN),
  schemaRevision: z.number().int().safe().min(1),
}).strict();

export const externalDatasetRefSchema = z.object({
  kind: z.literal('external'),
  system: z.string().regex(CODE),
  objectType: z.string().regex(CODE),
  schemaVersion: z.string().regex(VERSION),
}).strict();

export const datasetRefSchema = z.discriminatedUnion('kind', [
  nativeDatasetRefSchema,
  externalDatasetRefSchema,
]);

export const datasetRecordRefSchema = z.object({
  dataset: datasetRefSchema,
  recordId: z.string().regex(RECORD_ID),
  version: z.string().regex(VERSION).optional(),
}).strict();

export type DatasetRef = z.infer<typeof datasetRefSchema>;
export type DatasetRecordRef = z.infer<typeof datasetRecordRefSchema>;

/** 解析并冻结跨系统数据集引用，禁止 URL、凭据和任意属性路径。 */
export function parseDatasetRef(value: unknown): DatasetRef {
  const parsed = datasetRefSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException({ code: 'DATASET_REF_INVALID', message: '数据集引用不合法' });
  return freeze(structuredClone(parsed.data));
}

export function datasetRefKey(ref: DatasetRef): string {
  return ref.kind === 'native'
    ? `native:${ref.datasetId}:${ref.schemaRevision}`
    : `external:${ref.system}:${ref.objectType}:${ref.schemaVersion}`;
}

export function sameDatasetRef(left: unknown, right: DatasetRef): boolean {
  const parsed = datasetRefSchema.safeParse(left);
  return parsed.success && datasetRefKey(parsed.data) === datasetRefKey(right);
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) freeze(entry);
  }
  return value;
}
