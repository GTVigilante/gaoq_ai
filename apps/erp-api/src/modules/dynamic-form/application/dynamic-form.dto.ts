import { ArrayMaxSize, ArrayMinSize, IsArray, IsObject, IsString, Matches, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

const CODE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

export class CreateDynamicFormDto {
  @IsString() @Matches(CODE) code!: string;
  @IsObject() definition!: Record<string, unknown>;
}

export class UpdateDynamicFormDto {
  @IsObject() definition!: Record<string, unknown>;
}

export class WriteDynamicFormRecordDto {
  @IsObject() values!: Record<string, unknown>;
}

export class BulkWriteDynamicFormRecordDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50)
  @ValidateNested({ each: true }) @Type(() => WriteDynamicFormRecordDto)
  items!: WriteDynamicFormRecordDto[];
}

export class EmptyDynamicFormActionDto {}

export class CreateMultidimensionalBaseDto {
  @IsString() @Matches(CODE) code!: string;
  @IsObject() definition!: Record<string, unknown>;
}

export class UpdateMultidimensionalBaseDto {
  @IsObject() definition!: Record<string, unknown>;
}
