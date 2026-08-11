import { ForbiddenException, Injectable } from '@nestjs/common';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { SupplierMemberAuthorizationService } from '../../supplier/application/supplier-member-authorization.service.js';
import type { PayableItem, PayableStatus } from '../domain/payable.js';
import { PayableRepository } from '../persistence/payable.repository.js';

export interface SupplierIncomeProjection {
  readonly summary: {
    readonly grossAmountMinor: string;
    readonly withholdingAmountMinor: string;
    readonly netAmountMinor: string;
    readonly awaitingAmountMinor: string;
    readonly processingAmountMinor: string;
    readonly paidAmountMinor: string;
    readonly attentionAmountMinor: string;
    readonly currency: 'CNY';
    readonly itemCount: number;
  };
  readonly items: readonly {
    readonly id: string;
    readonly payableNumber: string;
    readonly engagementId: string;
    readonly grossAmountMinor: string;
    readonly withholdingAmountMinor: string;
    readonly netAmountMinor: string;
    readonly currency: 'CNY';
    readonly status: PayableStatus;
    readonly failureCode: string | null;
    readonly updatedAt: string;
  }[];
}

/** 从可信本人关系生成最小收益投影，不暴露税务处理、资金指令或证据地址。 */
@Injectable()
export class SupplierIncomeService {
  constructor(
    private readonly context: TenantContextService,
    private readonly members: SupplierMemberAuthorizationService,
    private readonly payables: PayableRepository,
  ) {}

  async getSelfIncome(): Promise<{
    readonly supplierId: string;
    readonly income: SupplierIncomeProjection;
  }> {
    this.scope();
    const member = await this.members.resolveUniqueSelf('income_read');
    const items = await this.payables.listBySupplier(member.supplierId);
    return Object.freeze({ supplierId: member.supplierId, income: project(items) });
  }

  private scope(): void {
    if (!this.context.getActorRequired().scopes.includes('erp:supplier:self:income:read')) {
      throw new ForbiddenException({
        code: 'SUPPLIER_INCOME_SCOPE_DENIED',
        message: '当前身份无权读取本人收益',
      });
    }
  }
}

function project(values: readonly PayableItem[]): SupplierIncomeProjection {
  let gross = 0n; let withholding = 0n; let net = 0n;
  let awaiting = 0n; let processing = 0n; let paid = 0n; let attention = 0n;
  for (const value of values) {
    const amount = BigInt(value.netAmountMinor);
    gross += BigInt(value.grossAmountMinor);
    withholding += BigInt(value.withholdingAmountMinor);
    net += amount;
    if (['prepared', 'pending_approval', 'approved'].includes(value.status)) awaiting += amount;
    else if (value.status === 'submitted') processing += amount;
    else if (value.status === 'paid') paid += amount;
    else attention += amount;
  }
  return Object.freeze({
    summary: Object.freeze({
      grossAmountMinor: gross.toString(), withholdingAmountMinor: withholding.toString(),
      netAmountMinor: net.toString(), awaitingAmountMinor: awaiting.toString(),
      processingAmountMinor: processing.toString(), paidAmountMinor: paid.toString(),
      attentionAmountMinor: attention.toString(), currency: 'CNY' as const,
      itemCount: values.length,
    }),
    items: Object.freeze(values.map((value) => Object.freeze({
      id: value.id, payableNumber: value.payableNumber, engagementId: value.engagementId,
      grossAmountMinor: value.grossAmountMinor,
      withholdingAmountMinor: value.withholdingAmountMinor,
      netAmountMinor: value.netAmountMinor, currency: value.currency, status: value.status,
      failureCode: value.failureCode, updatedAt: value.updatedAt,
    }))),
  });
}
