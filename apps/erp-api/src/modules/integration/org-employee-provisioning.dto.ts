import { Type } from 'class-transformer';
import {
  IsDefined,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** 员工标识：字母数字及 . _ : -，长度 1..128。 */
const EMPLOYEE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** 国际区号：+ 开头，首位 1-9，共 2..5 位（如 +86、+852）。 */
const COUNTRY_CODE_PATTERN = /^\+[1-9]\d{0,3}$/;

/** 手机号用户号码部分：首位非零，共 6..15 位数字。 */
const SUBSCRIBER_NUMBER_PATTERN = /^[1-9]\d{5,14}$/;

/**
 * 手机号联系方式。
 * 注意：此处仅做格式校验，手机号属于敏感信息，
 * 服务层必须在落库前完成加密与摘要计算，严禁明文持久化。
 */
export class OrgProvisioningMobileDto {
  /** 国际区号，形态如 +86。 */
  @IsString()
  @Matches(COUNTRY_CODE_PATTERN, { message: 'countryCode 必须为 + 开头的国际区号' })
  countryCode!: string;

  /** 用户号码部分，不含区号与分隔符。 */
  @IsString()
  @Matches(SUBSCRIBER_NUMBER_PATTERN, { message: 'subscriberNumber 必须为 6..15 位且首位非零的数字' })
  subscriberNumber!: string;
}

/**
 * 私密通道联系方式集合。
 * email 与 mobile 均为可选；「至少提供一种联系方式」由服务层二次校验，
 * DTO 不做交叉字段校验，也不做任何平台（钉钉/飞书）分支。
 */
export class OrgProvisioningContactDto {
  /** 邮箱地址；大小写归一化（转小写）留给服务层处理。 */
  @IsOptional()
  @IsEmail({}, { message: 'email 必须为合法邮箱地址' })
  @MaxLength(254, { message: 'email 最长 254 字符' })
  email?: string;

  /** 手机号联系方式。 */
  @IsOptional()
  @ValidateNested()
  @Type(() => OrgProvisioningMobileDto)
  mobile?: OrgProvisioningMobileDto;
}

/**
 * 员工首次开户私密通道创建请求。
 * 用途：接收「将联系方式通过私密通道传递给员工」的开户请求。
 * 约定：DTO 仅做形态校验，不含平台分支逻辑；
 * 联系方式至少一项、幂等与加密落库均由服务层负责。
 */
export class CreateOrgEmployeeProvisioningRequestDto {
  /** ERP 侧员工标识。 */
  @IsString()
  @Matches(EMPLOYEE_ID_PATTERN, {
    message: 'employeeId 仅允许字母数字及 . _ : -，长度 1..128',
  })
  employeeId!: string;

  /** 开户目标平台渠道。 */
  @IsIn(['dingtalk', 'feishu'], { message: 'channel 仅支持 dingtalk 或 feishu' })
  channel!: 'dingtalk' | 'feishu';

  /** 私密通道联系方式（至少一项由服务层校验）。 */
  @IsDefined({ message: 'contact 为必填' })
  @ValidateNested()
  @Type(() => OrgProvisioningContactDto)
  contact!: OrgProvisioningContactDto;
}
