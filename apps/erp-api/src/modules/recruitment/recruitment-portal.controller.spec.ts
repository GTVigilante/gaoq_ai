import { describe, expect, it, vi } from 'vitest';

import { REQUIRED_SCOPES_KEY } from '../identity/auth.decorators.js';
import type { RecruitmentManagementService } from './application/recruitment-management.service.js';
import { RecruitmentPortalController } from './recruitment-portal.controller.js';

describe('RecruitmentPortalController', () => {
  it('使用独立门户 Scope 并原样返回应用服务最小投影', async () => {
    const positions = [{
      id: '01J8ZQK7V0A2M4N6P8R0T2W4Y8',
      title: '小红书经纪人',
      department: '内容商业化中心',
      location: '上海',
      headcount: 2,
      publishedAt: '2026-07-21T00:00:00.000Z',
    }];
    const listPortalPositions = vi.fn().mockResolvedValue(positions);
    const controller = new RecruitmentPortalController({
      listPortalPositions,
    } as unknown as RecruitmentManagementService);
    const method = Object.getOwnPropertyDescriptor(
      RecruitmentPortalController.prototype,
      'listPositions',
    )?.value as object;

    expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, method))
      .toEqual(['erp:recruitment:portal:read']);
    await expect(controller.listPositions()).resolves.toEqual({ positions });
    expect(listPortalPositions).toHaveBeenCalledOnce();
  });
});
