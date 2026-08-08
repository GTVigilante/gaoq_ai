import { Body, Controller, Get, Param, Post } from '@nestjs/common';

import {
  MasterDataService,
  type MasterDataApplyResult,
  type MasterDataSnapshotApplyResult,
} from './master-data.service.js';

@Controller('integrations/erp')
export class MasterDataController {
  constructor(private readonly masterData: MasterDataService) {}

  /** 接收 ERP Outbox Relay 投递的版本化 CloudEvent。 */
  @Post('events')
  async receiveEvent(@Body() body: unknown): Promise<MasterDataApplyResult> {
    return this.masterData.applyEvent(body);
  }

  /** 应用 ERP 权威快照页，支持首次同步和事件缺口恢复。 */
  @Post('snapshots')
  async receiveSnapshot(
    @Body() body: unknown,
  ): Promise<MasterDataSnapshotApplyResult> {
    return this.masterData.applySnapshotPage(body);
  }

  /** 查询算薪侧员工只读投影，仍受可信租户与部门范围限制。 */
  @Get('employees/:employeeId')
  async getEmployee(
    @Param('employeeId') employeeId: string,
  ): Promise<Record<string, unknown>> {
    return this.masterData.getEmployee(employeeId);
  }
}
