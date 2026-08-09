import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class CreateReportingLineDto {
  @IsString() @Matches(ID) employeeId!: string;
  @IsString() @Matches(ID) managerEmployeeId!: string;
  @IsString() @Matches(DATE) effectiveFrom!: string;
  @IsOptional() @IsString() @Matches(DATE) effectiveTo?: string | null;
}

export class CreateHrbpAssignmentDto {
  @IsString() @Matches(ID) departmentId!: string;
  @IsString() @Matches(ID) primaryEmployeeId!: string;
  @IsArray() @ArrayMaxSize(3) @ArrayUnique()
  @IsString({ each: true }) @Matches(ID, { each: true })
  backupEmployeeIds!: string[];
  @IsBoolean() inheritToDescendants!: boolean;
  @IsString() @Matches(DATE) effectiveFrom!: string;
  @IsOptional() @IsString() @Matches(DATE) effectiveTo?: string | null;
}

export class WorkforceAsOfQueryDto {
  @IsString() @Matches(DATE) @MaxLength(10) asOf!: string;
}
