import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
} from 'class-validator';

import type { CareOccasionChannel } from '../domain/index.js';

export class UpdateMyCareOccasionPreferenceDto {
  @IsBoolean()
  birthdayEnabled!: boolean;

  @IsBoolean()
  anniversaryEnabled!: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @IsEnum(['email', 'sms', 'feishu', 'dingtalk'], { each: true })
  preferredChannels!: CareOccasionChannel[];
}
