import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  Matches,
} from 'class-validator';

const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

class NamedCodeDto {
  @IsString()
  @Matches(CODE_PATTERN)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name!: string;
}

export class CreateDepartmentDto extends NamedCodeDto {
  @IsOptional()
  @IsEnum(['active', 'inactive'])
  status?: 'active' | 'inactive';

  @IsOptional()
  @Matches(ULID_PATTERN)
  parentId?: string | null;

  @IsOptional()
  @Matches(ULID_PATTERN)
  managerId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateDepartmentDto {
  @IsOptional()
  @Matches(CODE_PATTERN)
  code?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name?: string;

  @IsOptional()
  @IsEnum(['active', 'inactive'])
  status?: 'active' | 'inactive';

  @IsOptional()
  @Matches(ULID_PATTERN)
  parentId?: string | null;

  @IsOptional()
  @Matches(ULID_PATTERN)
  managerId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class CreatePositionDto extends NamedCodeDto {
  @IsOptional()
  @IsEnum(['active', 'inactive'])
  status?: 'active' | 'inactive';
}

export class UpdatePositionDto {
  @IsOptional()
  @Matches(CODE_PATTERN)
  code?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name?: string;

  @IsOptional()
  @IsEnum(['active', 'inactive'])
  status?: 'active' | 'inactive';
}

export class CreateJobLevelDto extends NamedCodeDto {
  @IsEnum(['professional', 'management'])
  track!: 'professional' | 'management';

  @IsInt()
  @Min(1)
  @Max(30)
  rank!: number;
}

export class UpdateJobLevelDto {
  @IsOptional()
  @Matches(CODE_PATTERN)
  code?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name?: string;

  @IsOptional()
  @IsEnum(['professional', 'management'])
  track?: 'professional' | 'management';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  rank?: number;
}

export class CreateEmployeeDto {
  @Matches(CODE_PATTERN)
  employeeNo!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  displayName!: string;

  @IsOptional()
  @IsEnum(['probation', 'active', 'suspended', 'terminated'])
  status?: 'probation' | 'active' | 'suspended' | 'terminated';

  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @Matches(ULID_PATTERN, { each: true })
  departmentIds!: string[];

  @Matches(ULID_PATTERN)
  primaryDepartmentId!: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @Matches(ULID_PATTERN, { each: true })
  positionIds?: string[];

  @IsOptional()
  @Matches(ULID_PATTERN)
  jobLevelId?: string | null;
}

export class UpdateEmployeeDto {
  @IsOptional()
  @Matches(CODE_PATTERN)
  employeeNo?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  displayName?: string;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @Matches(ULID_PATTERN, { each: true })
  departmentIds?: string[];

  @IsOptional()
  @Matches(ULID_PATTERN)
  primaryDepartmentId?: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @Matches(ULID_PATTERN, { each: true })
  positionIds?: string[];

  @IsOptional()
  @Matches(ULID_PATTERN)
  jobLevelId?: string | null;
}

export class TransitionEmployeeStatusDto {
  @IsEnum(['probation', 'active', 'suspended', 'terminated'])
  status!: 'probation' | 'active' | 'suspended' | 'terminated';
}
