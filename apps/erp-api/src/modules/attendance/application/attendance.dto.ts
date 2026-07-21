import { IsEnum, IsISO8601, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export class AttendanceImpactDto {
  @IsInt() @Min(0) @Max(44_640) workedMinutes!: number;
  @IsInt() @Min(0) @Max(44_640) leaveMinutes!: number;
  @IsInt() @Min(0) @Max(44_640) overtimeMinutes!: number;
  @IsInt() @Min(0) @Max(44_640) absentMinutes!: number;
}

export class IngestAttendanceSourceFactDto {
  @Matches(ID) employeeId!: string;
  @Matches(/^[a-z][a-z0-9_]{1,31}$/) providerCode!: string;
  @Matches(/^[\x20-\x7e]{1,256}$/) externalEventId!: string;
  @IsEnum(['punch_in', 'punch_out', 'shift', 'leave', 'overtime', 'travel'])
  factType!: 'punch_in' | 'punch_out' | 'shift' | 'leave' | 'overtime' | 'travel';
  @IsISO8601({ strict: true, strictSeparator: true }) occurredAt!: string;
  @IsString() @MinLength(1) @MaxLength(64) timeZone!: string;
  @ValidateNested() @Type(() => AttendanceImpactDto) impact!: AttendanceImpactDto;
  @IsISO8601({ strict: true, strictSeparator: true }) sourceObservedAt!: string;
}

export class RegisterAttendanceCorrectionDto {
  @Matches(ULID) approvalInstanceId!: string;
}

export class RequestAttendanceCorrectionDto {
  @Matches(ULID) sourceFactId!: string;
  @ValidateNested() @Type(() => AttendanceImpactDto) replacementImpact!: AttendanceImpactDto;
  @Matches(/^[A-Z][A-Z0-9_]{1,63}$/) reasonCode!: string;
}

export class CloseAttendanceMonthDto {
  @Matches(ID) employeeId!: string;
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/) month!: string;
  @Matches(/^[A-Za-z0-9._:-]{1,64}$/) rulesetVersion!: string;
  @IsISO8601({ strict: true, strictSeparator: true }) sourceCutoffAt!: string;
  @IsOptional() @Matches(ULID) supersessionApprovalInstanceId?: string;
}
