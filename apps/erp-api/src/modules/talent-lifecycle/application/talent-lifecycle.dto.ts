import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import type {
  TalentLifecycleStage,
  TalentTouchpointChannel,
  TalentTouchpointKind,
  TalentTouchpointOutcome,
} from '../domain/index.js';

const LIFECYCLE_STAGES: readonly TalentLifecycleStage[] = [
  'talent_pool', 'recruiting', 'offer', 'onboarding', 'employed',
  'offboarding', 'alumni', 'former_employee', 'inactive',
];
const TOUCHPOINT_KINDS: readonly TalentTouchpointKind[] = [
  'candidate_outreach', 'interview_support', 'offer_support', 'onboarding_support',
  'employee_care', 'offboarding_support', 'alumni_engagement', 'rehire_contact',
];
const TOUCHPOINT_CHANNELS: readonly TalentTouchpointChannel[] = [
  'email', 'phone', 'wechat', 'meeting', 'portal', 'internal',
];
const TOUCHPOINT_OUTCOMES: readonly TalentTouchpointOutcome[] = [
  'contacted', 'no_response', 'follow_up_required', 'resolved',
  'declined', 'joined', 'departed', 'consent_withdrawn',
];

export class ListTalentLifecycleDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  search?: string;

  @IsOptional()
  @IsEnum(LIFECYCLE_STAGES)
  stage?: TalentLifecycleStage;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}

export class CreateTalentTouchpointDto {
  @IsEnum(TOUCHPOINT_KINDS)
  kind!: TalentTouchpointKind;

  @IsEnum(TOUCHPOINT_CHANNELS)
  channel!: TalentTouchpointChannel;

  @IsEnum(['inbound', 'outbound', 'internal'])
  direction!: 'inbound' | 'outbound' | 'internal';

  @IsEnum(TOUCHPOINT_OUTCOMES)
  outcome!: TalentTouchpointOutcome;

  @IsISO8601({ strict: true, strictSeparator: true })
  occurredAt!: string;

  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  nextActionAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1_000)
  note?: string;
}

export class CloseTalentTouchpointDto {
  @IsEnum(['completed', 'cancelled'])
  status!: 'completed' | 'cancelled';
}

export class CandidateIdDto {
  @Matches(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
  candidateId!: string;
}
