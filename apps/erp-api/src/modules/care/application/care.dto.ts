import {
  IsEnum,
  IsArray,
  IsISO8601,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export class CreateOffboardingCaseDto {
  @Matches(ULID) employmentId!: string;
  @IsEnum(['voluntary_resignation', 'involuntary_termination', 'retirement', 'contract_end'])
  separationType!:
    | 'voluntary_resignation'
    | 'involuntary_termination'
    | 'retirement'
    | 'contract_end';
  @Matches(/^[A-Z][A-Z0-9_]{1,63}$/) reasonCode!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) lastWorkingDate!: string;
  @IsString() @MinLength(1) @MaxLength(64) tenantTimeZone!: string;
  @IsISO8601({ strict: true, strictSeparator: true }) accessDisableAt!: string;
}

export class RecordCareTaskEvidenceDto {
  @Matches(ULID) evidenceId!: string;
}

export class CreateAlumniConsentDto {
  @IsEnum(['alumni_network', 'rehire_contact', 'alumni_events'])
  purpose!: 'alumni_network' | 'rehire_contact' | 'alumni_events';
  @IsArray() @IsEnum(['email', 'sms', 'phone', 'wechat'], { each: true })
  channels!: ('email' | 'sms' | 'phone' | 'wechat')[];
  @Matches(/^[A-Za-z0-9._-]{1,64}$/) consentVersion!: string;
  @Matches(ULID) consentEvidenceId!: string;
  @IsISO8601({ strict: true, strictSeparator: true }) grantedAt!: string;
  @IsISO8601({ strict: true, strictSeparator: true }) expiresAt!: string;
}
