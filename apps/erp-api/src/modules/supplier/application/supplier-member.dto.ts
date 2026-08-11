import { ArrayMaxSize, ArrayMinSize, IsArray, IsEnum, IsOptional, IsString, Matches } from 'class-validator';

import { SUPPLIER_MEMBER_PERMISSIONS, SUPPLIER_MEMBER_ROLES } from '../domain/supplier-member.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const REASON = /^[a-z][a-z0-9_]{2,63}$/u;

export class CreateSupplierMemberDto {
  @IsString() @Matches(ID) actorId!: string;
  @IsString() @Matches(ID) performerRef!: string;
  @IsEnum(SUPPLIER_MEMBER_ROLES) role!: (typeof SUPPLIER_MEMBER_ROLES)[number];
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(6)
  @IsEnum(SUPPLIER_MEMBER_PERMISSIONS, { each: true })
  permissions!: (typeof SUPPLIER_MEMBER_PERMISSIONS)[number][];
  @IsString() @Matches(ID) evidenceRef!: string;
  @IsString() @Matches(DATE) validFrom!: string;
  @IsOptional() @IsString() @Matches(DATE) validUntil?: string;
}

export class RevokeSupplierMemberDto {
  @IsString() @Matches(REASON) reasonCode!: string;
}
