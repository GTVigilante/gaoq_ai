import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsObject,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;

export class CreateDataMigrationRunDto {
  @IsString() @Matches(SOURCE_ID) sourceSystem!: string;
  @IsString() @Matches(SOURCE_ID) sourceRunId!: string;
  @IsEnum(['full', 'incremental']) mode!: 'full' | 'incremental';
  @IsEnum(['org_reference']) scope!: 'org_reference';
  @IsInt() @Min(1) @Max(10_000_000) expectedSourceCount!: number;
  @IsString() @Length(43, 43) @Matches(HASH) expectedSourceChecksum!: string;
}

export class MigrationAttachmentDto {
  @IsString() @Matches(SOURCE_ID) sourceAttachmentId!: string;
  @IsString() @Length(43, 43) @Matches(HASH) checksum!: string;
}

export class ApplyDataMigrationRecordDto {
  @IsInt() @Min(1) @Max(10_000_000) sequence!: number;
  @IsString() @Matches(SOURCE_ID) sourceRecordId!: string;
  @IsString() @MinLength(1) @MaxLength(64) sourceVersion!: string;
  @IsEnum(['org.department', 'org.position', 'org.job_level'])
  entityType!: 'org.department' | 'org.position' | 'org.job_level';
  @IsObject() payload!: Readonly<Record<string, unknown>>;
  @IsString() @Length(43, 43) @Matches(HASH) payloadHash!: string;
  @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) @Matches(SOURCE_ID, { each: true })
  associationSourceIds!: string[];
  @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => MigrationAttachmentDto)
  attachments!: MigrationAttachmentDto[];
}
