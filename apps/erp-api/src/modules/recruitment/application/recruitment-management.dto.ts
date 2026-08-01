import {
  IsEnum,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class CreateRecruitmentRequisitionDto {
  @Matches(RESOURCE_ID_PATTERN)
  departmentId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @Matches(/\S/u)
  positionTitle!: string;

  @IsInt()
  @Min(1)
  @Max(10_000)
  headcount!: number;

  @IsString()
  @MinLength(3)
  @MaxLength(4_096)
  @Matches(/^(?:\s*\S){3}[\s\S]*$/u)
  justification!: string;
}

export class CreateRecruitmentPositionDto {
  @Matches(RESOURCE_ID_PATTERN)
  jobLevelId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @Matches(/\S/u)
  location!: string;
}

export class TransitionRecruitmentPositionDto {
  @IsEnum(['open', 'paused', 'closed'])
  targetStatus!: 'open' | 'paused' | 'closed';
}
