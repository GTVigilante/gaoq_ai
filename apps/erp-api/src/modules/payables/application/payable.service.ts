import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession } from 'mongoose';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { EngagementService } from '../../engagement/application/engagement.service.js';
import {
  approvePayable,
  createPayable,
  settlePayable,
  submitPayable,
  submitToTreasury,
  type PayableItem,
} from '../domain/payable.js';
import { PayableOutboxWriter } from '../persistence/payable-outbox.writer.js';
import { PayableRepository } from '../persistence/payable.repository.js';
import type {
  BindTreasuryInstructionDto,
  MaterializePayableDto,
  PayableEvidenceDto,
  PayableSearchDto,
  SettlePayableDto,
} from './payable.dto.js';

type AcceptedPayableSource = Awaited<ReturnType<EngagementService['getAcceptedPayableSource']>>;

@Injectable()
export class PayableService {
  constructor(
    private readonly context: TenantContextService,
    private readonly idempotency: IdempotencyService,
    private readonly engagements: EngagementService,
    private readonly repository: PayableRepository,
    private readonly outbox: PayableOutboxWriter,
  ) {}

  async materialize(key: string, input: MaterializePayableDto) {
    this.scope('erp:payables:materialize');
    const source = await this.engagements.getAcceptedPayableSource(input.engagementId);

    return this.idempotency.execute('payables.item.materialize', key, input, async (session) => {
      const existing = await this.repository.findByEngagement(source.engagementId, session);
      if (existing !== null) {
        this.assertExistingMatchesSource(existing, source, input);
        return { payable: project(existing) };
      }

      const now = new Date();
      const id = createEventId(now);
      const value = domain(() =>
        createPayable(
          {
            id,
            tenantId: this.tenant(),
            payableNumber: `PAY-${id.slice(-10)}`,
            ...source,
            withholdingAmountMinor: input.withholdingAmountMinor,
            taxTreatmentCode: input.taxTreatmentCode,
          },
          now,
        ),
      );
      await this.repository.insert(value, session);
      await this.outbox.append(value, 'prepared', session);
      return { payable: project(value) };
    });
  }

  async get(id: string) {
    this.scope('erp:payables:management:read');
    return project(await this.required(id));
  }

  async search(input: PayableSearchDto) {
    this.scope('erp:payables:management:read');
    const result = await this.repository.search({
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.afterId === undefined ? {} : { afterId: input.afterId }),
      limit: input.limit ?? 20,
    });
    return Object.freeze({
      items: Object.freeze(result.items.map(project)),
      nextCursor: result.nextCursor,
    });
  }

  async submit(id: string, expected: number, key: string) {
    return this.transition(
      'payables.item.submit',
      'erp:payables:management:write',
      id,
      expected,
      key,
      {},
      'submitted_for_approval',
      submitPayable,
    );
  }

  async approve(id: string, expected: number, key: string, input: PayableEvidenceDto) {
    this.scope('erp:payables:management:decide');
    return this.idempotency.execute(
      'payables.item.approve', key, { id, expected, evidenceRef: input.evidenceRef },
      async (session) => {
        const current = await this.required(id, session);
        if (current.version !== expected) {
          throw new ConflictException({
            code: 'PAYABLE_VERSION_CONFLICT', message: '应付事项版本已变化',
          });
        }
        const updated = domain(() => approvePayable(current, input.evidenceRef, new Date()));
        await this.repository.replace(updated, expected, session);
        await this.outbox.append(updated, 'approved', session);
        await this.outbox.appendTreasuryMaterializationRequest(updated, session);
        return { payable: project(updated) };
      },
    );
  }

  async bindTreasury(
    id: string,
    expected: number,
    key: string,
    input: BindTreasuryInstructionDto,
  ) {
    return this.transition(
      'payables.item.bind_treasury',
      'erp:payables:treasury:bind',
      id,
      expected,
      key,
      { treasuryInstructionRef: input.treasuryInstructionRef },
      'submitted_to_treasury',
      (value, now) => submitToTreasury(value, input.treasuryInstructionRef, now),
    );
  }

  async settle(id: string, expected: number, key: string, input: SettlePayableDto) {
    return this.transition(
      'payables.item.settle',
      'erp:payables:treasury:settle',
      id,
      expected,
      key,
      {
        outcome: input.outcome,
        evidenceRef: input.evidenceRef,
        failureCode: input.failureCode ?? null,
      },
      input.outcome,
      (value, now) =>
        settlePayable(value, input.outcome, input.evidenceRef, input.failureCode ?? null, now),
    );
  }

  private assertExistingMatchesSource(
    existing: PayableItem,
    source: AcceptedPayableSource,
    input: MaterializePayableDto,
  ): void {
    const matches =
      existing.engagementId === source.engagementId &&
      existing.engagementVersion === source.engagementVersion &&
      existing.supplierId === source.supplierId &&
      existing.grossAmountMinor === source.grossAmountMinor &&
      existing.currency === source.currency &&
      existing.acceptanceEvidenceRef === source.acceptanceEvidenceRef &&
      existing.withholdingAmountMinor === input.withholdingAmountMinor &&
      existing.taxTreatmentCode === input.taxTreatmentCode;
    if (!matches) {
      throw new ConflictException({
        code: 'PAYABLE_SOURCE_CONFLICT',
        message: '既有应付事项与当前可信验收来源不一致',
      });
    }
  }

  private async transition(
    operation: string,
    scope: string,
    id: string,
    expected: number,
    key: string,
    request: Record<string, unknown>,
    event: Parameters<PayableOutboxWriter['append']>[1],
    change: (value: PayableItem, now: Date) => PayableItem,
  ) {
    this.scope(scope);
    return this.idempotency.execute(
      operation,
      key,
      { id, expected, ...request },
      async (session) => {
        const current = await this.required(id, session);
        if (current.version !== expected) {
          throw new ConflictException({
            code: 'PAYABLE_VERSION_CONFLICT',
            message: '应付事项版本已变化',
          });
        }
        const updated = domain(() => change(current, new Date()));
        await this.repository.replace(updated, expected, session);
        await this.outbox.append(updated, event, session);
        return { payable: project(updated) };
      },
    );
  }

  private async required(id: string, session?: ClientSession) {
    const value = await this.repository.findById(id, session);
    if (value === null) {
      throw new NotFoundException({ code: 'PAYABLE_NOT_FOUND', message: '应付事项不存在' });
    }
    return value;
  }

  private scope(scope: string): void {
    if (!this.context.getActorRequired().scopes.includes(scope)) {
      throw new ForbiddenException({
        code: 'PAYABLE_SCOPE_DENIED',
        message: '当前身份无权执行应付操作',
      });
    }
  }

  private tenant(): string {
    return this.context.getTenantRequired().tenantId;
  }
}

function project(value: PayableItem) {
  return Object.freeze({
    id: value.id,
    payableNumber: value.payableNumber,
    engagementId: value.engagementId,
    engagementVersion: value.engagementVersion,
    supplierId: value.supplierId,
    grossAmountMinor: value.grossAmountMinor,
    withholdingAmountMinor: value.withholdingAmountMinor,
    netAmountMinor: value.netAmountMinor,
    currency: value.currency,
    taxTreatmentCode: value.taxTreatmentCode,
    treasuryInstructionRef: value.treasuryInstructionRef,
    status: value.status,
    failureCode: value.failureCode,
    version: value.version,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  });
}

function domain<T>(handler: () => T): T {
  try {
    return handler();
  } catch (error) {
    const code = error instanceof Error ? error.message : 'PAYABLE_DOMAIN_INVALID';
    if (code.startsWith('PAYABLE_')) {
      throw new BadRequestException({ code, message: '应付业务规则校验失败' });
    }
    throw error;
  }
}
