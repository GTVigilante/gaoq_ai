import { IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export class ReconcileAttendanceProviderCoverageDto {
  @Matches(ULID) stateId!: string;
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/) month!: string;
  @IsOptional() @Matches(ULID) afterMappingId?: string;
  @IsOptional() @IsInt() @Min(1) @Max(500) limit?: number;
}
