import { Injectable } from '@nestjs/common';
import type { ClientSession } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { planBaseAutomations, type AutomationRecordEvent } from '../domain/base-automation-interpreter.js';
import { BaseAutomationRunRepository } from '../persistence/base-automation-run.repository.js';
import { MultidimensionalBaseRepository } from '../persistence/multidimensional-base.repository.js';

/** 在表单记录事务内登记自动化运行；正文仅用于条件解释，不写入运行账本。 */
@Injectable()
export class BaseAutomationSchedulerService {
  constructor(
    private readonly context: TenantContextService,
    private readonly bases: MultidimensionalBaseRepository,
    private readonly runs: BaseAutomationRunRepository,
  ) {}

  async scheduleRecord(event: AutomationRecordEvent, session: ClientSession): Promise<number> {
    // v1 失败关闭级联自动化，避免自更新或跨表环路形成无界运行链。
    if (this.context.getActorRequired().actorId === 'system:base-automation') return 0;
    const bases = await this.bases.listByTable(event.tableId, session);
    let count = 0;
    for (const base of bases) {
      for (const plan of planBaseAutomations(base, event)) {
        await this.runs.schedule(plan, session);
        count += 1;
      }
    }
    return count;
  }
}
