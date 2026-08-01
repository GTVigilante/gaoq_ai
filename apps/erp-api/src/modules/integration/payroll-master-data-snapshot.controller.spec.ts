import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it, vi } from 'vitest';

import { REQUIRED_SCOPES_KEY } from '../identity/auth.decorators.js';
import { PayrollMasterDataSnapshotController } from './payroll-master-data-snapshot.controller.js';
import type { PayrollMasterDataSnapshotService } from './payroll-master-data-snapshot.service.js';

describe('PayrollMasterDataSnapshotController', () => {
  it('固定专业算薪快照路由、GET 方法与最小读取 Scope', () => {
    expect(Reflect.getMetadata(PATH_METADATA, PayrollMasterDataSnapshotController))
      .toBe('integrations/payroll/v1/master-data/snapshots');
    const handler = Object.getOwnPropertyDescriptor(
      PayrollMasterDataSnapshotController.prototype,
      'page',
    )?.value as object;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('/');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, handler))
      .toEqual(['erp:payroll:master-data:read']);
  });

  it.each([undefined, 'cursor-001'])(
    '只把不透明游标 %s 交给应用服务',
    async (cursor) => {
      const result = Object.freeze({
        contractVersion: '1.0.0' as const,
        snapshotId: 'a'.repeat(64),
        generatedAt: '2026-07-28T00:00:00.000Z',
        nextCursor: null,
        departments: [],
        employees: [],
        employments: [],
        snapshotDigest: 'a'.repeat(64),
      });
      const page = vi.fn().mockResolvedValue(result);
      const controller = new PayrollMasterDataSnapshotController({
        page,
      } as unknown as PayrollMasterDataSnapshotService);

      await expect(controller.page(cursor)).resolves.toBe(result);
      expect(page).toHaveBeenCalledWith(cursor);
    },
  );
});
