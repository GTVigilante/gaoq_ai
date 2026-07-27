import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { CourseVersionRepository } from './knowledge.repositories.js';
import type { KnowledgeCourseVersionDocument } from './knowledge.schemas.js';

describe('Knowledge 课程搜索授权仓储', () => {
  it('强制可信租户，受众维度内 OR、维度间 AND', async () => {
    const exec = vi.fn().mockResolvedValue([]);
    const lean = vi.fn().mockReturnValue({ exec });
    const limit = vi.fn().mockReturnValue({ lean });
    const sort = vi.fn().mockReturnValue({ limit });
    const find = vi.fn().mockReturnValue({ sort });
    const context = {
      getTenantRequired: vi.fn().mockReturnValue({ tenantId: 'tenant-001' }),
    } as unknown as TenantContextService;
    const repository = new CourseVersionRepository(
      context,
      { find } as unknown as Model<KnowledgeCourseVersionDocument>,
    );

    await repository.findSearchEligible(
      ['assigned-course-001'],
      ['department-001'],
      ['position-001'],
    );

    expect(find).toHaveBeenCalledWith({
      tenantId: 'tenant-001',
      status: 'published',
      $or: [
        { id: { $in: ['assigned-course-001'] } },
        {
          audienceMode: 'employment_scope',
          $and: [
            {
              $or: [
                { audienceDepartmentIds: { $size: 0 } },
                { audienceDepartmentIds: { $in: ['department-001'] } },
              ],
            },
            {
              $or: [
                { audiencePositionIds: { $size: 0 } },
                { audiencePositionIds: { $in: ['position-001'] } },
              ],
            },
          ],
        },
      ],
    });
    expect(limit).toHaveBeenCalledWith(201);
  });

  it('不存在分配或任职授权投影时不访问数据库', async () => {
    const find = vi.fn();
    const context = {
      getTenantRequired: vi.fn().mockReturnValue({ tenantId: 'tenant-001' }),
    } as unknown as TenantContextService;
    const repository = new CourseVersionRepository(
      context,
      { find } as unknown as Model<KnowledgeCourseVersionDocument>,
    );

    await expect(repository.findSearchEligible([], [], [])).resolves.toEqual([]);
    expect(find).not.toHaveBeenCalled();
  });
});
