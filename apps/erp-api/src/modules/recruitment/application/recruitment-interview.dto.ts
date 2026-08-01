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
const TIMEZONE_PATTERN = /^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+)$/;
const UTC_MILLISECONDS_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export class ScheduleRecruitmentInterviewDto {
  @IsInt()
  @Min(1)
  @Max(100)
  roundNumber!: number;

  @IsEnum(['phone', 'video', 'onsite'])
  mode!: 'phone' | 'video' | 'onsite';

  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(UTC_MILLISECONDS_PATTERN)
  startsAt!: string;

  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(UTC_MILLISECONDS_PATTERN)
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
  @Matches(/\S/u)
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
  @Matches(/\S/u)
  notes!: string;
}
