import { ForbiddenException, Injectable } from '@nestjs/common';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  onboardingTaskStatuses,
  type OnboardingInstance,
  type OnboardingTaskCode,
} from '../domain/index.js';
import { OnboardingInstanceRepository } from '../persistence/onboarding.repositories.js';

export interface OnboardingTalentSnapshot {
  readonly id: string;
  readonly applicationId: string;
  readonly offerId: string;
  readonly departmentId: string;
  readonly proposedStartDate: string;
  readonly status: OnboardingInstance['status'];
  readonly tasks: Readonly<Record<OnboardingTaskCode, 'pending' | 'completed'>>;
  readonly employmentId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 人才全景的入职域窄查询口；只返回进度，不返回证据引用。 */
@Injectable()
export class OnboardingTalentSourceService {
  constructor(
    private readonly context: TenantContextService,
    private readonly instances: OnboardingInstanceRepository,
  ) {}

  async getByCandidateId(candidateId: string): Promise<readonly OnboardingTalentSnapshot[]> {
    this.assertScope();
    const actor = this.context.getActorRequired();
    const tenantId = this.context.getTenantRequired().tenantId;
    const instances = await this.instances.findByCandidateId(candidateId);
    if (instances.some((instance) =>
      instance.tenantId !== tenantId || instance.candidateId !== candidateId
    )) {
      throw new Error('TALENT_LIFECYCLE_ONBOARDING_REFERENCE_INVALID');
    }
    const visible = actor.scopes.includes('erp:talent-lifecycle:read_all')
      ? instances
      : instances.filter((instance) => actor.departmentIds.includes(instance.departmentId));
    return Object.freeze(visible.map((instance) => Object.freeze({
      id: instance.id,
      applicationId: instance.applicationId,
      offerId: instance.offerId,
      departmentId: instance.departmentId,
      proposedStartDate: instance.proposedStartDate,
      status: instance.status,
      tasks: onboardingTaskStatuses(instance),
      employmentId: instance.employmentId,
      createdAt: instance.createdAt,
      updatedAt: instance.updatedAt,
    })));
  }

  private assertScope(): void {
    if (!this.context.getActorRequired().scopes.includes('erp:talent-lifecycle:read')) {
      throw new ForbiddenException({
        code: 'TALENT_LIFECYCLE_SCOPE_DENIED',
        message: '缺少人才全周期读取权限',
      });
    }
  }
}
