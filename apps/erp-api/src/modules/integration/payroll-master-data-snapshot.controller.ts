import { Controller, Get, Query } from '@nestjs/common';
import type { PayrollMasterDataSnapshotPage } from '@gaoq/platform-contracts';

import { RequiredScopes } from '../identity/auth.decorators.js';
import { PayrollMasterDataSnapshotService } from './payroll-master-data-snapshot.service.js';

/** 专业算薪系统首次同步与版本缺口修复接口。 */
@Controller('integrations/payroll/v1/master-data/snapshots')
export class PayrollMasterDataSnapshotController {
  constructor(private readonly snapshots: PayrollMasterDataSnapshotService) {}

  @Get()
  @RequiredScopes('erp:payroll:master-data:read')
  async page(
    @Query('cursor') cursor: string | undefined,
  ): Promise<PayrollMasterDataSnapshotPage> {
    return this.snapshots.page(cursor);
  }
}
