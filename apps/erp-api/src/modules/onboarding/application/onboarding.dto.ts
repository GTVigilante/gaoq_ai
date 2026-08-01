import { IsOptional, Matches } from 'class-validator';

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export class RecordOnboardingTaskEvidenceDto {
  @Matches(ULID_PATTERN)
  evidenceId!: string;

  @IsOptional()
  @Matches(ULID_PATTERN)
  orgPositionId?: string;
}
