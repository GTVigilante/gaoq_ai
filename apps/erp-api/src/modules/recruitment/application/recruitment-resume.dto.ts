import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

const EVIDENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TAG_CODE_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

export class RequestRecruitmentResumeAnalysisDto {
  @Matches(EVIDENCE_ID_PATTERN)
  resumeEvidenceId!: string;
}

export class RecruitmentResumeTagDecisionDto {
  @Matches(TAG_CODE_PATTERN)
  code!: string;

  @IsEnum(['confirmed', 'rejected'])
  status!: 'confirmed' | 'rejected';
}

export class ReviewRecruitmentResumeAnalysisDto {
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => RecruitmentResumeTagDecisionDto)
  decisions!: RecruitmentResumeTagDecisionDto[];

  @IsArray()
  @ArrayMaxSize(20)
  @Matches(TAG_CODE_PATTERN, { each: true })
  manualTagCodes!: string[];
}

export class ListRecruitmentResumeAnalysesDto {
  @IsOptional()
  @Matches(TAG_CODE_PATTERN)
  tag?: string;

  @IsOptional()
  @IsEnum(['queued', 'processing', 'review_required', 'approved', 'failed'])
  status?: 'queued' | 'processing' | 'review_required' | 'approved' | 'failed';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}
