import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, Matches, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class CreatePayrollPeriodDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/) period!: string;
}

export class StartPayrollCollectionDto {
  @IsInt() @Min(1) expectedVersion!: number;
}

export class PayrollVersionCommandDto {
  @IsInt() @Min(1) expectedVersion!: number;
}

export class ApplyPayrollApprovalDto extends PayrollVersionCommandDto {
  @Matches(ULID) approvalInstanceId!: string;
}

export class LockPayrollPeriodDto extends PayrollVersionCommandDto {
  @Matches(ULID) strongAuthEvidenceId!: string;
}

export class PayrollAmountComponentDto {
  @Matches(/^[A-Z][A-Z0-9_]{0,63}$/) code!: string;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) amountMinor!: number;
}

export class PayrollAttendanceAdjustmentDto {
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) overtimePayMinorPerMinute!: number;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) absenceDeductionMinorPerMinute!: number;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) unpaidLeaveDeductionMinorPerMinute!: number;
}

export class AttestCompensationProfileDto {
  @Matches(ID) employeeId!: string;
  @Matches(DATE) effectiveFrom!: string;
  @IsOptional() @Matches(DATE) effectiveTo!: string | null;
  @Matches(ID) approvalEvidenceId!: string;
  @IsArray() @ArrayMaxSize(128) @ValidateNested({ each: true }) @Type(() => PayrollAmountComponentDto)
  taxableEarnings!: PayrollAmountComponentDto[];
  @IsArray() @ArrayMaxSize(128) @ValidateNested({ each: true }) @Type(() => PayrollAmountComponentDto)
  nonTaxableEarnings!: PayrollAmountComponentDto[];
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) employeeSocialInsuranceMinor!: number;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) employeeHousingFundMinor!: number;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) specialAdditionalDeductionMinor!: number;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) otherPreTaxWithholdingMinor!: number;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) postTaxDeductionMinor!: number;
  @ValidateNested() @Type(() => PayrollAttendanceAdjustmentDto)
  attendanceAdjustment!: PayrollAttendanceAdjustmentDto;
}

export class PayrollTaxBracketDto {
  @IsOptional() @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) upperBoundMinor!: number | null;
  @IsInt() @Min(0) @Max(10_000) rateBps!: number;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) quickDeductionMinor!: number;
}

export class AttestPayrollRulePackDto {
  @Matches(ID) code!: string;
  @Matches(ID) jurisdictionCode!: string;
  @Matches(DATE) effectiveFrom!: string;
  @IsOptional() @Matches(DATE) effectiveTo!: string | null;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) monthlyBasicDeductionMinor!: number;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(64)
  @ValidateNested({ each: true }) @Type(() => PayrollTaxBracketDto)
  taxBrackets!: PayrollTaxBracketDto[];
  @Matches(/^[A-Za-z0-9_-]{43}$/) sourceDigest!: string;
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/) sourceReference!: string;
  @Matches(ULID) approvalEvidenceId!: string;
}
