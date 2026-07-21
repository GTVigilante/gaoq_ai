import { Type } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const E164_PATTERN = /^\+[1-9][0-9]{7,14}$/;

class CandidateIdentityDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name!: string;

  @IsOptional()
  @Matches(E164_PATTERN)
  phone?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;
}

class CandidateConsentDto {
  @Matches(CODE_PATTERN)
  version!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(256)
  purpose!: string;

  @IsEnum(['portal', 'channel', 'manual_import'])
  source!: 'portal' | 'channel' | 'manual_import';

  @IsISO8601({ strict: true, strictSeparator: true })
  expiresAt!: string;

  @IsISO8601({ strict: true, strictSeparator: true })
  retentionExpiresAt!: string;
}

export class CreateCandidateApplicationDto {
  @Matches(ULID_PATTERN)
  positionId!: string;

  @Matches(CODE_PATTERN)
  sourceChannel!: string;

  @ValidateNested()
  @Type(() => CandidateIdentityDto)
  candidate!: CandidateIdentityDto;

  @ValidateNested()
  @Type(() => CandidateConsentDto)
  consent!: CandidateConsentDto;
}

export class TransitionCandidateApplicationDto {
  @IsEnum([
    'screening', 'interview', 'rejected', 'withdrawn',
  ])
  targetStage!:
    | 'screening' | 'interview' | 'rejected' | 'withdrawn';

  @IsOptional()
  @Matches(CODE_PATTERN)
  reasonCode?: string;

}
