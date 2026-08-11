import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';

import { AuditService } from '../../core/audit/audit.service.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import { SupplierIncomeService } from './application/supplier-income.service.js';

/** 本人收益读取边界；读取审计不可用时失败关闭。 */
@Controller('supplier-self/income')
export class SupplierSelfIncomeController {
  constructor(
    private readonly income: SupplierIncomeService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequiredScopes('erp:supplier:self:income:read')
  async get() {
    const result = await this.income.getSelfIncome();
    try {
      await this.audit.record({
        action: 'supplier.self.income.read', resourceType: 'supplier_relationship',
        resourceId: result.supplierId, riskLevel: 'R2', outcome: 'success',
        metadata: { itemCount: result.income.summary.itemCount },
      });
    } catch {
      throw new ServiceUnavailableException({
        code: 'SUPPLIER_INCOME_AUDIT_UNAVAILABLE',
        message: '收益读取审计暂不可用',
      });
    }
    return result.income;
  }
}
