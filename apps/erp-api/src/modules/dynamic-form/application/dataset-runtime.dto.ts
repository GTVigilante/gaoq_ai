import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsObject, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

const FIELD_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export class ResolveDatasetRecordDto {
  @IsObject() record!: Record<string, unknown>;
  @IsOptional() @IsArray() @ArrayMaxSize(100)
  @IsString({ each: true }) @Matches(FIELD_KEY, { each: true })
  fieldKeys?: string[];
}

export class QueryDatasetRecordsDto {
  @IsObject() dataset!: Record<string, unknown>;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10)
  @IsObject({ each: true }) filters!: Record<string, unknown>[];
  @IsOptional() @IsArray() @ArrayMaxSize(100)
  @IsString({ each: true }) @Matches(FIELD_KEY, { each: true })
  fieldKeys?: string[];
  @IsOptional() @IsInt() @Min(1) @Max(100) limit?: number;
}
