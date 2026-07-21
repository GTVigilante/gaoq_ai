import { IsIn, IsInt, Length, Matches, Min } from 'class-validator';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export class AttestTreasuryBankAccountDto {
  @IsIn(['organization', 'employee']) ownerType!: 'organization' | 'employee';
  @Matches(ID) ownerId!: string;
  @Length(1, 140) accountName!: string;
  @Matches(/^[0-9]{8,32}$/) account!: string;
  @Matches(/^[0-9A-Z]{8,12}$/) clearingCode!: string;
  @Matches(/^CNY$/) currency!: 'CNY';
  @Matches(ULID) approvalEvidenceId!: string;
}

export class PrepareTreasuryDisbursementDto {
  @Matches(ULID) payrollPeriodId!: string;
  @IsInt() @Min(1) expectedPayrollVersion!: number;
  @Matches(ULID) debtorBankAccountId!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) requestedExecutionDate!: string;
}

export class ApproveTreasuryExportDto {
  @IsInt() @Min(1) expectedVersion!: number;
  @Matches(ULID) strongAuthEvidenceId!: string;
}

export class SubmitTreasuryDisbursementDto {
  @IsInt() @Min(1) expectedVersion!: number;
}

export class IngestTreasuryBankReturnDto {
  @IsInt() @Min(1) expectedVersion!: number;
}

export class ExecuteTreasuryReconciliationDto {
  @IsInt() @Min(1) expectedVersion!: number;
}

export class CreateTreasuryRecoveryDto {
  @IsInt() @Min(1) expectedVersion!: number;
  @Matches(ULID) strongAuthEvidenceId!: string;
}
