import { createHash } from 'node:crypto';

import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import type { Model } from 'mongoose';

import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import { RecruitmentOfferService } from '../recruitment/application/recruitment-offer.service.js';
import { ESignBinding, type ESignBindingDocument } from './esign-binding.schema.js';
import { ESignFlowRecord, type ESignFlowDocument } from './esign-flow.schema.js';
import { ESignWebhookCryptoService } from './esign-webhook-crypto.service.js';

const EXTERNAL_FLOW_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface ESignFlowSummary extends Record<string, unknown> {
  readonly id: string;
  readonly offerId: string;
  readonly status: ESignFlowRecord['status'];
  readonly providerStatus: number | null;
  readonly reviewRequired: boolean;
  readonly version: number;
}

/** eSign 流程应用服务；只接受已验证的 Adapter 回执，不信任客户端租户或流程绑定。 */
@Injectable()
export class ESignFlowService {
  constructor(
    private readonly context: TenantContextService,
    private readonly offers: RecruitmentOfferService,
    private readonly crypto: ESignWebhookCryptoService,
    @InjectModel(ESignBinding.name)
    private readonly bindings: Model<ESignBindingDocument>,
    @InjectModel(ESignFlowRecord.name)
    private readonly flows: Model<ESignFlowDocument>,
  ) {}

  /** 供未来 eSign Adapter 在发起成功后登记；同一 Offer 只允许一个活跃流程。 */
  async registerForOffer(offerId: string, externalFlowId: string): Promise<ESignFlowSummary> {
    this.requireScope('erp:integration:esign:create');
    if (!EXTERNAL_FLOW_ID_PATTERN.test(externalFlowId)) throw new ConflictException({
      code: 'ESIGN_EXTERNAL_FLOW_ID_INVALID', message: 'eSign 外部流程标识无效',
    });
    const tenantId = this.context.getTenantRequired().tenantId;
    const offer = await this.offers.get(offerId);
    if (offer.status !== 'accepted') throw new ConflictException({
      code: 'ESIGN_OFFER_STATUS_INVALID', message: '只有已接受 Offer 可发起签署流程',
    });
    const binding = await this.bindings.findOne({
      tenantId, provider: 'esign_cn', status: 'active',
    }).lean().exec();
    if (binding === null) throw new ConflictException({
      code: 'ESIGN_BINDING_NOT_FOUND', message: '当前租户未配置 eSign 绑定',
    });
    const externalFlowIdHash = hashExternalFlowId(binding.appId, externalFlowId);
    const existing = await this.flows.findOne({ tenantId, offerId }).lean().exec();
    if (existing !== null) {
      if (existing.externalFlowIdHash !== externalFlowIdHash) throw new ConflictException({
        code: 'ESIGN_OFFER_FLOW_CONFLICT', message: 'Offer 已绑定其他 eSign 流程',
      });
      return summary(existing);
    }
    const now = new Date();
    const id = createEventId(now);
    const protectedId = this.crypto.protectExternalId(tenantId, id, externalFlowId);
    try {
      const created = await this.flows.create({
        id, tenantId, provider: 'esign_cn', appId: binding.appId, offerId,
        externalFlowIdHash, ...protectedId, status: 'awaiting_signature', providerStatus: null,
        lastProviderAction: null, providerOccurredAt: null, reviewRequired: false,
        reviewCode: null, signedEvidenceId: null, version: 1,
      });
      return summary(created.toObject());
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const raced = await this.flows.findOne({ tenantId, offerId }).lean().exec();
      if (raced === null || raced.externalFlowIdHash !== externalFlowIdHash) {
        throw new ConflictException({
          code: 'ESIGN_OFFER_FLOW_CONFLICT', message: 'Offer eSign 流程并发绑定冲突',
        });
      }
      return summary(raced);
    }
  }

  async getExternalIdForAdapter(flowId: string): Promise<string> {
    this.requireScope('erp:integration:esign:read_external_id');
    const tenantId = this.context.getTenantRequired().tenantId;
    const flow = await this.flows.findOne({ tenantId, id: flowId }).lean().exec();
    if (flow === null) throw new ConflictException({
      code: 'ESIGN_FLOW_NOT_FOUND', message: 'eSign 流程不存在',
    });
    return this.crypto.unprotectExternalId(tenantId, flow.id, flow);
  }

  private requireScope(scope: string): void {
    if (!this.context.getActorRequired().scopes.includes(scope)) throw new ForbiddenException({
      code: 'ESIGN_TRUSTED_ADAPTER_REQUIRED', message: '必须由受信任 eSign Adapter 执行',
    });
  }
}

export function hashExternalFlowId(appId: string, externalFlowId: string): string {
  return createHash('sha256')
    .update(appId, 'utf8').update(Buffer.from([0])).update(externalFlowId, 'utf8')
    .digest('base64url');
}

function summary(flow: ESignFlowRecord): ESignFlowSummary {
  return Object.freeze({
    id: flow.id, offerId: flow.offerId, status: flow.status,
    providerStatus: flow.providerStatus, reviewRequired: flow.reviewRequired, version: flow.version,
  });
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11_000;
}
