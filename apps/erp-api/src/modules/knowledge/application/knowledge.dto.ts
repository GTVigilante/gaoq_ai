import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class CreateCourseVersionDto {
  @Matches(CODE) courseCode!: string;
  @IsInt() @Min(1) revision!: number;
  @IsString() @MinLength(1) @MaxLength(128) title!: string;
  @Matches(ULID) contentRef!: string;
  @IsOptional() @Matches(ULID) questionBankRef?: string;
  @IsOptional() @Matches(/^[A-Za-z0-9_-]{43}$/) questionBankDigest?: string;
  @IsOptional() @IsInt() @Min(0) @Max(10_000) passingScoreBps?: number;
  @IsOptional() @IsIn(['assigned_only', 'employment_scope'])
  audienceMode?: 'assigned_only' | 'employment_scope';
  @IsOptional() @IsArray() @ArrayMaxSize(200) @ArrayUnique() @Matches(ULID, { each: true })
  audienceDepartmentIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(200) @ArrayUnique() @Matches(ULID, { each: true })
  audiencePositionIds?: string[];
}

export class AssignCourseDto {
  @Matches(ULID) courseVersionId!: string;
  @IsBoolean() mandatory!: boolean;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) dueDate!: string;
}

export class GradeExamDto {
  @Matches(ULID) submissionRef!: string;
}

export class RecordTrainingProgressDto {
  @Matches(CODE) source!: string;
  @Matches(ULID) sourceEventId!: string;
  @IsInt() @Min(0) @Max(10_000) progressBps!: number;
  @IsISO8601({ strict: true, strictSeparator: true }) occurredAt!: string;
}

export class CompleteTrainingAssignmentDto {
  @IsOptional() @Matches(ULID) passedExamAttemptId?: string;
}

export class SearchMyKnowledgeDto {
  @IsString()
  @MinLength(2)
  @MaxLength(128)
  @Matches(/^[\p{L}\p{M}\p{N}\s._-]+$/u)
  query!: string;

  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{16,256}$/)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number;
}
