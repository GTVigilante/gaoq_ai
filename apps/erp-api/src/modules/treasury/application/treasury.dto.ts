import { IsIn, Length, Matches } from 'class-validator';

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
