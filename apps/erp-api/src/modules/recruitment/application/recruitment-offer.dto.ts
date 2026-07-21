import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

class RecruitmentOfferTermsDto {
  @IsEnum(['CNY'])
  currency!: 'CNY';

  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  monthlyBaseSalaryMinor!: number;

  @IsInt()
  @Min(1)
  @Max(24)
  salaryMonths!: number;

  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  annualVariableTargetMinor!: number;

  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  signingBonusMinor!: number;

  @Matches(ISO_DATE_PATTERN)
  proposedStartDate!: string;

  @IsInt()
  @Min(0)
  @Max(12)
  probationMonths!: number;

  @Matches(CODE_PATTERN)
  employmentType!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(256)
  workLocation!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4_096)
  benefitsSummary!: string;
}

export class CreateRecruitmentOfferDto {
  @Matches(ULID_PATTERN)
  completedInterviewId!: string;

  @ValidateNested()
  @Type(() => RecruitmentOfferTermsDto)
  terms!: RecruitmentOfferTermsDto;

  @IsISO8601({ strict: true, strictSeparator: true })
  expiresAt!: string;

  @IsISO8601({ strict: true, strictSeparator: true })
  retentionExpiresAt!: string;
}
