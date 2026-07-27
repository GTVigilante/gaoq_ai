import { IsString, Matches } from 'class-validator';

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export class AttestPersonBirthdayDto {
  @IsString()
  @Matches(/^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/)
  monthDay!: string;

  @IsString()
  @Matches(ULID_PATTERN)
  identityEvidenceId!: string;

  @IsString()
  @Matches(ULID_PATTERN)
  birthdayEvidenceId!: string;
}
