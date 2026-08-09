import { Type } from 'class-transformer';
import { IsInt, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const REASON = /^[a-z][a-z0-9_]{2,63}$/;

export class PerformanceThresholdsDto {
  @IsInt() @Min(0) @Max(10_000) S!: number;
  @IsInt() @Min(0) @Max(10_000) A!: number;
  @IsInt() @Min(0) @Max(10_000) B!: number;
  @IsInt() @Min(0) @Max(10_000) C!: number;
}

export class PerformanceCoefficientsDto {
  @IsInt() @Min(0) @Max(30_000) S!: number;
  @IsInt() @Min(0) @Max(30_000) A!: number;
  @IsInt() @Min(0) @Max(30_000) B!: number;
  @IsInt() @Min(0) @Max(30_000) C!: number;
  @IsInt() @Min(0) @Max(30_000) D!: number;
}

export class CreatePerformanceTemplateDto {
  @IsString() @MaxLength(128) name!: string;
  @IsInt() @Min(0) @Max(10_000) okrWeightBps!: number;
  @IsInt() @Min(0) @Max(10_000) kpiWeightBps!: number;
  @IsInt() @Min(0) @Max(10_000) competencyWeightBps!: number;
  @IsObject() @ValidateNested() @Type(() => PerformanceThresholdsDto)
  thresholds!: PerformanceThresholdsDto;
  @IsObject() @ValidateNested() @Type(() => PerformanceCoefficientsDto)
  coefficients!: PerformanceCoefficientsDto;
}

export class CreatePerformanceCycleDto {
  @IsString() @MaxLength(128) name!: string;
  @IsString() @Matches(ID) templateId!: string;
  @IsString() @Matches(DATE) startDate!: string;
  @IsString() @Matches(DATE) endDate!: string;
}

export class SubmitPerformanceScoreDto {
  @IsInt() @Min(0) @Max(10_000) scoreBps!: number;
  @IsString() @Matches(ID) evidenceRef!: string;
}

export class CalibratePerformanceDto {
  @IsInt() @Min(0) @Max(10_000) scoreBps!: number;
  @IsString() @Matches(REASON) reasonCode!: string;
}

export class AppealPerformanceDto {
  @IsString() @Matches(REASON) reasonCode!: string;
  @IsString() @Matches(ID) evidenceRef!: string;
}

export class FinalizePerformanceDto {
  @IsOptional() @IsInt() @Min(0) @Max(10_000) scoreBps?: number;
  @IsOptional() @IsString() @Matches(REASON) reasonCode?: string;
}
