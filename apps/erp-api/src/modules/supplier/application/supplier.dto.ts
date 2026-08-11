import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';

import { SUPPLIER_CAPABILITY_LEVELS, SUPPLIER_LEGAL_FORMS, SUPPLIER_PARTY_KINDS, SUPPLIER_QUALIFICATION_TYPES, SUPPLIER_RATE_UNITS, SUPPLIER_RISK_TIERS, SUPPLIER_STATUSES } from '../domain/supplier.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const CODE = /^[a-z][a-z0-9_.:-]{1,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONEY = /^(0|[1-9][0-9]{0,14})$/;
const REASON = /^[a-z][a-z0-9_]{2,63}$/;

export class SupplierLegalIdentityDto {
  @IsEnum(['national_id', 'passport', 'unified_social_credit_code', 'business_registration_no'])
  identifierType!: 'national_id' | 'passport' | 'unified_social_credit_code' | 'business_registration_no';
  @IsString() @Matches(/^[A-Za-z0-9\s-]{6,40}$/) identifier!: string;
  @IsString() @MaxLength(128) legalName!: string;
}

export class SupplierCapabilityDto {
  @IsString() @Matches(CODE) serviceCategoryCode!: string;
  @IsEnum(SUPPLIER_CAPABILITY_LEVELS) level!: (typeof SUPPLIER_CAPABILITY_LEVELS)[number];
  @IsOptional() @IsString() @Matches(ID) evidenceRef?: string;
  @IsOptional() @IsString() @Matches(DATE) validUntil?: string;
}

export class SupplierRateDto {
  @IsString() @Matches(CODE) serviceCategoryCode!: string;
  @IsEnum(SUPPLIER_RATE_UNITS) unit!: (typeof SUPPLIER_RATE_UNITS)[number];
  @IsString() @Matches(MONEY) amountMinor!: string;
  @IsEnum(['CNY']) currency!: 'CNY';
  @IsBoolean() taxIncluded!: boolean;
  @IsString() @Matches(DATE) validFrom!: string;
  @IsOptional() @IsString() @Matches(DATE) validUntil?: string;
}

export class CreateSupplierDraftDto {
  @IsEnum(SUPPLIER_PARTY_KINDS) partyKind!: (typeof SUPPLIER_PARTY_KINDS)[number];
  @IsEnum(SUPPLIER_LEGAL_FORMS) legalForm!: (typeof SUPPLIER_LEGAL_FORMS)[number];
  @IsString() @MaxLength(128) displayName!: string;
  @ValidateNested() @Type(() => SupplierLegalIdentityDto) legalIdentity!: SupplierLegalIdentityDto;
  @IsString() @Matches(ID) ownerEmployeeId!: string;
  @IsString() @Matches(ID) responsibleDepartmentId!: string;
  @IsEnum(SUPPLIER_RISK_TIERS) riskTier!: (typeof SUPPLIER_RISK_TIERS)[number];
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => SupplierCapabilityDto)
  capabilities!: SupplierCapabilityDto[];
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => SupplierRateDto)
  rates!: SupplierRateDto[];
}

export class UpdateSupplierDraftDto extends CreateSupplierDraftDto {}

export class ReplaceSupplierCapabilitiesDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => SupplierCapabilityDto)
  capabilities!: SupplierCapabilityDto[];
}

export class ReplaceSupplierRatesDto {
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => SupplierRateDto)
  rates!: SupplierRateDto[];
}

export class EmptySupplierActionDto {}

export class SupplierQualificationDecisionDto {
  @IsEnum(SUPPLIER_QUALIFICATION_TYPES) type!: (typeof SUPPLIER_QUALIFICATION_TYPES)[number];
  @IsString() @Matches(ID) evidenceRef!: string;
  @IsOptional() @IsString() @Matches(DATE) validUntil?: string;
}

export class DecideSupplierDto {
  @IsEnum(['approved', 'rejected']) outcome!: 'approved' | 'rejected';
  @IsString() @Matches(ID) decisionEvidenceRef!: string;
  @ValidateIf((value: DecideSupplierDto) => value.outcome === 'approved')
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(6) @ValidateNested({ each: true }) @Type(() => SupplierQualificationDecisionDto)
  qualifications?: SupplierQualificationDecisionDto[];
  @ValidateIf((value: DecideSupplierDto) => value.outcome === 'rejected')
  @IsString() @Matches(REASON) reasonCode?: string;
}

export class ChangeSupplierStatusDto {
  @IsString() @Matches(REASON) reasonCode!: string;
}

export class ReactivateSupplierDto {
  @IsString() @Matches(ID) decisionEvidenceRef!: string;
}

export class SupplierSearchDto {
  @IsOptional() @IsEnum(SUPPLIER_STATUSES) status?: (typeof SUPPLIER_STATUSES)[number];
  @IsOptional() @IsString() @Matches(ID) ownerEmployeeId?: string;
  @IsOptional() @IsString() @Matches(CODE) serviceCategoryCode?: string;
  @IsOptional() @IsString() @Matches(ULID) afterId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class SupplierEligibilityDto {
  @IsString() @Matches(CODE) purpose!: string;
  @IsString() @Matches(CODE) serviceCategoryCode!: string;
  @IsOptional() @IsString() @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) at?: string;
}
