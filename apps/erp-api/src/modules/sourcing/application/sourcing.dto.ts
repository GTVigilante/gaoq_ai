import { Type } from 'class-transformer'; import { ArrayMaxSize, IsArray, IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { SOURCING_MODES, SOURCING_STATUSES } from '../domain/sourcing.js';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u; const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u; const CODE = /^[a-z][a-z0-9_.:-]{1,63}$/u; const MONEY = /^(0|[1-9][0-9]{0,14})$/u; const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u; const REASON = /^[a-z][a-z0-9_]{2,63}$/u;
export class CreateSourcingDraftDto { @IsString() @MaxLength(160) title!: string; @IsString() @Matches(CODE) serviceCategoryCode!: string; @IsEnum(SOURCING_MODES) mode!: (typeof SOURCING_MODES)[number]; @IsString() @Matches(MONEY) budgetCeilingMinor!: string; @IsEnum(['CNY']) currency!: 'CNY'; @IsString() @Matches(ID) ownerEmployeeId!: string; @IsString() @Matches(ID) responsibleDepartmentId!: string; @IsString() @Matches(ISO) responseDueAt!: string; @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) @Matches(ULID, { each: true }) invitedSupplierIds!: string[]; }
export class SourcingApprovalDto { @IsString() @Matches(ID) approvalEvidenceRef!: string; }
export class RecordSourcingResponseDto { @IsString() @Matches(ULID) supplierId!: string; @IsString() @Matches(MONEY) quotationMinor!: string; @IsString() @Matches(ID) proposalRef!: string; }
export class SupplierSelfSourcingResponseDto { @IsString() @Matches(MONEY) quotationMinor!: string; @IsString() @Matches(ID) proposalRef!: string; }
export class AwardSourcingDto { @IsString() @Matches(ULID) supplierId!: string; @IsString() @Matches(MONEY) agreedAmountMinor!: string; @IsString() @Matches(ID) decisionEvidenceRef!: string; }
export class CancelSourcingDto { @IsString() @Matches(REASON) reasonCode!: string; }
export class SourcingSearchDto { @IsOptional() @IsEnum(SOURCING_STATUSES) status?: (typeof SOURCING_STATUSES)[number]; @IsOptional() @IsString() @Matches(CODE) serviceCategoryCode?: string; @IsOptional() @IsString() @Matches(ULID) afterId?: string; @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number; }
export class SupplierSelfOpportunitySearchDto { @IsOptional() @IsString() @Matches(ULID) afterId?: string; @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number; }
export class EmptySourcingActionDto {}
