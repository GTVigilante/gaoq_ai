import { Controller, Get } from '@nestjs/common';

import { RequiredScopes } from '../identity/auth.decorators.js';
import {
  RecruitmentManagementService,
  type RecruitmentPortalPositionSummary,
} from './application/recruitment-management.service.js';

/**
 * 招聘门户的受保护服务间边界。
 *
 * 浏览器不得直接调用本控制器；租户与权限均来自门户 BFF 的服务令牌。
 */
@Controller('recruitment/portal')
export class RecruitmentPortalController {
  constructor(private readonly recruitment: RecruitmentManagementService) {}

  @Get('positions')
  @RequiredScopes('erp:recruitment:portal:read')
  async listPositions(): Promise<{
    readonly positions: readonly RecruitmentPortalPositionSummary[];
  }> {
    return { positions: await this.recruitment.listPortalPositions() };
  }
}
