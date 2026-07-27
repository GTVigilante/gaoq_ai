import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  OrgDomainError,
  attestPersonBirthday,
  buildPersonBirthdayAttestedEvent,
} from '../domain/index.js';
import { OrgPersonBirthdayBlindIndexService } from '../persistence/org-person-birthday-blind-index.service.js';
import {
  OrgWriteConflictError,
  PersonRepository,
} from '../persistence/org.repositories.js';
import { OrgOutboxWriter } from '../persistence/outbox.writer.js';
import type { AttestPersonBirthdayDto } from './org-person-birthday.dto.js';

export interface PersonBirthdayAttestationSummary extends Record<string, unknown> {
  readonly personId: string;
  readonly birthdayAttested: true;
  readonly version: number;
}

/** 生日证明写入口仅供身份服务调用；明文月日仅在内存中形成独立盲索引。 */
@Injectable()
export class OrgPersonBirthdayService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly persons: PersonRepository,
    private readonly blindIndex: OrgPersonBirthdayBlindIndexService,
    private readonly outbox: OrgOutboxWriter,
  ) {}

  async attest(
    personId: string,
    expectedVersion: number,
    key: string,
    input: AttestPersonBirthdayDto,
  ): Promise<{ readonly attestation: PersonBirthdayAttestationSummary }> {
    this.assertTrustedScope();
    const tenantId = this.context.getTenantRequired().tenantId;
    const fingerprints = this.blindIndex.fingerprints(tenantId, input.monthDay);
    const requestFingerprint = this.blindIndex.activeFingerprint(tenantId, input.monthDay);
    return this.run(async () => this.idempotency.execute(
      'org.person.birthday.attest',
      key,
      {
        personId,
        expectedVersion,
        identityEvidenceId: input.identityEvidenceId,
        birthdayEvidenceId: input.birthdayEvidenceId,
        birthdayFingerprint: requestFingerprint,
      },
      async (session) => {
        const current = await this.persons.findById(personId, session);
        if (current === null) throw new NotFoundException({
          code: 'ORG_PERSON_NOT_FOUND',
          message: '自然人主数据不存在',
        });
        const now = new Date();
        const person = attestPersonBirthday(current, {
          tenantId,
          expectedVersion,
          identityEvidenceId: input.identityEvidenceId,
          birthdayEvidenceId: input.birthdayEvidenceId,
        }, now);
        if (person !== current) {
          await this.persons.attestBirthday(person, fingerprints, expectedVersion, session);
          await this.outbox.append(buildPersonBirthdayAttestedEvent(person, now), session);
        }
        return {
          attestation: Object.freeze({
            personId: person.id,
            birthdayAttested: true as const,
            version: person.version,
          }),
        };
      },
    ));
  }

  private assertTrustedScope(): void {
    const actor = this.context.getActorRequired();
    if (
      !['service', 'system_job'].includes(actor.actorType) ||
      !actor.scopes.includes('erp:org:person:birthday:attest')
    ) {
      throw new ForbiddenException({
        code: 'ORG_BIRTHDAY_TRUSTED_WORKFLOW_REQUIRED',
        message: '生日证明必须由受信任身份工作流登记',
      });
    }
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof OrgWriteConflictError) {
        throw new ConflictException({
          code: 'ORG_VERSION_CONFLICT',
          message: error.message,
        });
      }
      if (error instanceof OrgDomainError) {
        if (error.code.includes('TENANT')) {
          throw new ForbiddenException({ code: `ORG_${error.code}`, message: error.message });
        }
        if (
          error.code.includes('VERSION') ||
          error.code.includes('IMMUTABLE') ||
          error.code.includes('MISMATCH')
        ) {
          throw new ConflictException({ code: `ORG_${error.code}`, message: error.message });
        }
        throw new BadRequestException({ code: `ORG_${error.code}`, message: error.message });
      }
      throw error;
    }
  }
}
