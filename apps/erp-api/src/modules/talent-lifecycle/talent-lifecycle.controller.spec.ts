import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { REQUIRED_SCOPES_KEY } from '../identity/auth.decorators.js';
import type { TalentLifecycleService } from './application/talent-lifecycle.service.js';
import { TalentLifecycleController } from './talent-lifecycle.controller.js';

const ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y6';

function fixture() {
  const lifecycle = { closeTouchpoint: vi.fn() };
  const controller = new TalentLifecycleController(
    lifecycle as unknown as TalentLifecycleService,
    { record: vi.fn() } as unknown as AuditService,
  );
  return { controller, lifecycle, response: { setHeader: vi.fn() } };
}

describe('TalentLifecycleController', () => {
  it('读取与服务触点写入使用分离的最小 Scope', () => {
    expect(scope('list')).toEqual(['erp:talent-lifecycle:read']);
    expect(scope('get')).toEqual(['erp:talent-lifecycle:read']);
    expect(scope('createTouchpoint')).toEqual([
      'erp:talent-lifecycle:read',
      'erp:talent-lifecycle:touchpoint:write',
    ]);
    expect(scope('closeTouchpoint')).toEqual([
      'erp:talent-lifecycle:read',
      'erp:talent-lifecycle:touchpoint:write',
    ]);
  });

  it('关闭跟进拒绝弱版本条件和非法标识', async () => {
    const store = fixture();
    await expect(store.controller.closeTouchpoint(
      ID,
      '1',
      'talent-touchpoint-close-001',
      { status: 'completed' },
      store.response as never,
    )).rejects.toBeInstanceOf(BadRequestException);
    await expect(store.controller.closeTouchpoint(
      'not-an-id',
      '"1"',
      'talent-touchpoint-close-001',
      { status: 'completed' },
      store.response as never,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(store.lifecycle.closeTouchpoint).not.toHaveBeenCalled();
  });
});

function scope(name: keyof TalentLifecycleController): unknown {
  const method = Object.getOwnPropertyDescriptor(
    TalentLifecycleController.prototype,
    name,
  )?.value as object;
  return Reflect.getMetadata(REQUIRED_SCOPES_KEY, method) as unknown;
}
