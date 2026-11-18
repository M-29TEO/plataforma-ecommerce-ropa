import { Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsInt, IsOptional, IsString, Length, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { ToBoolean } from './common';

export class SupplierContactDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @IsString() @MaxLength(20) phone?: string;
  @IsOptional() @IsString() @MaxLength(300) address?: string;
}

export class CreateSupplierDto {
  @IsString() @Length(1, 200) name!: string;
  @IsOptional() @Matches(/^\d{13}$/, { message: 'ruc debe tener 13 dígitos' }) ruc?: string;
  @IsOptional() @ValidateNested() @Type(() => SupplierContactDto) contact?: SupplierContactDto;
  @IsOptional() @IsInt() @Min(0) @Max(365) leadTimeDays?: number;
}

export class UpdateSupplierDto {
  @IsOptional() @IsString() @Length(1, 200) name?: string;
  @IsOptional() @Matches(/^\d{13}$/, { message: 'ruc debe tener 13 dígitos' }) ruc?: string;
  @IsOptional() @ValidateNested() @Type(() => SupplierContactDto) contact?: SupplierContactDto;
  @IsOptional() @IsInt() @Min(0) @Max(365) leadTimeDays?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class ListSuppliersQuery {
  @IsOptional() @ToBoolean() @IsBoolean() active?: boolean;
  @IsOptional() @IsString() @MaxLength(100) search?: string;
}
