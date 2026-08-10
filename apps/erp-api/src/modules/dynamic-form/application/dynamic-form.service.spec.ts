import 'reflect-metadata';

import { describe, expect, it, vi } from 'vitest';

import type { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { DynamicFormRepository } from '../persistence/dynamic-form.repository.js';
import type { DynamicFormOutboxWriter } from '../persistence/dynamic-form-outbox.writer.js';
import type { ExternalDatasetReferenceService } from '../runtime/external-dataset-reference.service.js';
import { BulkWriteDynamicFormRecordDto, WriteDynamicFormRecordDto } from './dynamic-form.dto.js';
import { DynamicFormService } from './dynamic-form.service.js';

const FORM_ID = '01J00000000000000000000001';

describe('DynamicFormService', () => {
  it('批量写入在进入幂等账本前把 DTO 转换为纯 JSON 请求', async () => {
    const execute = vi.fn((_operation: string, _key: string, request: unknown) => {
      const candidate = request as { readonly items: readonly unknown[] };
      expect(Object.getPrototypeOf(candidate)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(candidate.items[0])).toBe(Object.prototype);
      return Promise.resolve({ records: [] });
    });
    const service = new DynamicFormService(
      { getActorRequired: () => ({ scopes: ['erp:forms:data:write'] }) } as unknown as TenantContextService,
      { execute } as unknown as IdempotencyService,
      {} as DynamicFormRepository,
      {} as DynamicFormOutboxWriter,
      {} as ExternalDatasetReferenceService,
      {} as never,
    );
    const item = new WriteDynamicFormRecordDto();
    item.values = { name: '演示记录' };
    const input = new BulkWriteDynamicFormRecordDto();
    input.items = [item];

    await expect(service.createRecords(FORM_ID, 'demo-bulk-001', input))
      .resolves.toEqual({ records: [] });
    expect(execute).toHaveBeenCalledOnce();
  });
});
