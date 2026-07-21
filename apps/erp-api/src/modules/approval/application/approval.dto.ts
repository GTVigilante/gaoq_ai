import {
  IsEnum,
  IsObject,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import type { ApprovalFormData } from '../domain/condition.js';
import type { ApprovalTemplateDefinition } from '../domain/template.js';

const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class CreateApprovalTemplateDto {
  @Matches(CODE_PATTERN)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name!: string;

  @IsEnum(['R1', 'R2'])
  riskLevel!: 'R1' | 'R2';

  @IsObject()
  definition!: ApprovalTemplateDefinition;
}

export class CreateApprovalInstanceDto {
  @Matches(CODE_PATTERN)
  templateCode!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(256)
  title!: string;

  @IsObject()
  formData!: ApprovalFormData;
}

export class DecideApprovalInstanceDto {
  @Matches(ID_PATTERN)
  principalApproverId!: string;

  @IsEnum(['approved', 'rejected'])
  outcome!: 'approved' | 'rejected';
}

export class TransferApprovalTaskDto {
  @Matches(ID_PATTERN)
  fromApproverId!: string;

  @Matches(ID_PATTERN)
  toApproverId!: string;
}

export class AddApprovalSignerDto {
  @Matches(ID_PATTERN)
  approverId!: string;
}
