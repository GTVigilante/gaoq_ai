import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
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
  @IsEnum(['org_reference', 'org_workforce']) scope!: 'org_reference' | 'org_workforce';
  @IsInt() @Min(0) @Max(10_000_000) expectedSourceCount!: number;
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
  @IsEnum(['org.department', 'org.position', 'org.job_level', 'org.employee'])
  entityType!: 'org.department' | 'org.position' | 'org.job_level' | 'org.employee';
  @IsObject() payload!: Readonly<Record<string, unknown>>;
  @IsString() @Length(43, 43) @Matches(HASH) payloadHash!: string;
  @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) @Matches(SOURCE_ID, { each: true })
  associationSourceIds!: string[];
  @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => MigrationAttachmentDto)
  attachments!: MigrationAttachmentDto[];
}

export class DataMigrationEvidenceQueryDto {
  @IsEnum(['items', 'associations', 'attachments'])
  kind!: 'items' | 'associations' | 'attachments';

  @IsOptional() @IsString() @MaxLength(512) @Matches(/^[A-Za-z0-9_-]+$/)
  cursor?: string;

  @Type(() => Number) @IsInt() @Min(1) @Max(500)
  limit = 200;
}
