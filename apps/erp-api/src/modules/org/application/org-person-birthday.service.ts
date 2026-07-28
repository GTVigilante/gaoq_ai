import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';

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
import {
  attestPersonBirthdayRequestSchema,
  type AttestPersonBirthdayDto,
} from './org-person-birthday.dto.js';

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const attestationResultSchema = z.object({
  attestation: z.object({
    personId: z.string().regex(ULID_PATTERN),
    birthdayAttested: z.literal(true),
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }).strict(),
}).strict();

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
    personId: unknown,
    expectedVersion: unknown,
    key: unknown,
    input: unknown,
  ): Promise<{ readonly attestation: PersonBirthdayAttestationSummary }> {
    this.assertTrustedScope();
    const request = this.requireRequest(personId, expectedVersion, key, input);
    const tenantId = this.context.getTenantRequired().tenantId;
    const fingerprints = this.blindIndex.fingerprints(tenantId, request.input.monthDay);
    const requestFingerprint = this.blindIndex.activeFingerprint(
      tenantId,
      request.input.monthDay,
    );
    const result = await this.run(async () => this.idempotency.execute(
      'org.person.birthday.attest',
      request.key,
      {
        personId: request.personId,
        expectedVersion: request.expectedVersion,
        identityEvidenceId: request.input.identityEvidenceId,
        birthdayEvidenceId: request.input.birthdayEvidenceId,
        birthdayFingerprint: requestFingerprint,
      },
      async (session) => {
        const current = await this.persons.findById(request.personId, session);
        if (current === null) throw new NotFoundException({
          code: 'ORG_PERSON_NOT_FOUND',
          message: '自然人主数据不存在',
        });
        const now = new Date();
        const person = attestPersonBirthday(current, {
          tenantId,
          expectedVersion: request.expectedVersion,
          identityEvidenceId: request.input.identityEvidenceId,
          birthdayEvidenceId: request.input.birthdayEvidenceId,
        }, now);
        if (person !== current) {
          await this.persons.attestBirthday(
            person,
            fingerprints,
            request.expectedVersion,
            session,
          );
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
    return this.requireResult(result, request.personId, request.expectedVersion);
  }

  private requireRequest(
    personId: unknown,
    expectedVersion: unknown,
    key: unknown,
    input: unknown,
  ): Readonly<{
    personId: string;
    expectedVersion: number;
    key: string;
    input: AttestPersonBirthdayDto;
  }> {
    const parsedInput = attestPersonBirthdayRequestSchema.safeParse(input);
    if (
      typeof personId !== 'string' ||
      !ULID_PATTERN.test(personId) ||
      typeof expectedVersion !== 'number' ||
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 1 ||
      expectedVersion >= Number.MAX_SAFE_INTEGER ||
      typeof key !== 'string' ||
      !IDEMPOTENCY_KEY_PATTERN.test(key) ||
      !parsedInput.success
    ) {
      throw new BadRequestException({
        code: 'ORG_PERSON_BIRTHDAY_REQUEST_INVALID',
        message: '生日证明请求结构无效',
      });
    }
    return Object.freeze({
      personId,
      expectedVersion,
      key,
      input: Object.freeze(parsedInput.data),
    });
  }

  private requireResult(
    value: unknown,
    personId: string,
    expectedVersion: number,
  ): { readonly attestation: PersonBirthdayAttestationSummary } {
    const parsed = attestationResultSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.attestation.personId !== personId ||
      ![
        expectedVersion,
        expectedVersion + 1,
      ].includes(parsed.data.attestation.version)
    ) {
      throw new ServiceUnavailableException({
        code: 'ORG_PERSON_BIRTHDAY_RESULT_INVALID',
        message: '生日证明结果校验失败',
      });
    }
    return Object.freeze({
      attestation: Object.freeze(parsed.data.attestation),
    });
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
