import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsInt,
  IsISO8601,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TIMEZONE_PATTERN = /^(?:UTC|[A-Za-z_]+\/[A-Za-z0-9_+.-]+)$/;

export class ScheduleRecruitmentInterviewDto {
  @IsInt()
  @Min(1)
  @Max(100)
  roundNumber!: number;

  @IsEnum(['phone', 'video', 'onsite'])
  mode!: 'phone' | 'video' | 'onsite';

  @IsISO8601({ strict: true, strictSeparator: true })
  startsAt!: string;

  @IsISO8601({ strict: true, strictSeparator: true })
  endsAt!: string;

  @Matches(TIMEZONE_PATTERN)
  timezone!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ArrayUnique()
  @Matches(RESOURCE_ID_PATTERN, { each: true })
  interviewerIds!: string[];

  @IsString()
  @MinLength(1)
  @MaxLength(2_048)
  location!: string;
}

export class SubmitRecruitmentInterviewFeedbackDto {
  @IsEnum(['strong_hire', 'hire', 'no_hire', 'strong_no_hire'])
  recommendation!: 'strong_hire' | 'hire' | 'no_hire' | 'strong_no_hire';

  @IsInt()
  @Min(1)
  @Max(5)
  score!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(8_192)
  notes!: string;
}
