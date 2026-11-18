import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsEmail, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const ROLE_CODE = /^[a-z][a-z0-9_.-]{1,39}$/;

/** Filtros del listado de usuarios (GET /iam/users). */
export class ListUsersQueryDto {
  /** Busca en email, nombre, apellido y teléfono. */
  @IsOptional() @Transform(trim) @IsString() @Length(1, 100) q?: string;
  @IsOptional() @IsIn(['staff', 'customer', 'rider']) type?: 'staff' | 'customer' | 'rider';
  /** Sin estado se listan todas las cuentas salvo las anonimizadas. */
  @IsOptional() @IsIn(['active', 'blocked', 'pending']) status?: 'active' | 'blocked' | 'pending';
  @IsOptional() @Matches(ROLE_CODE, { message: 'role debe ser un código de rol' }) role?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100_000) offset?: number;
}

/** Alta de personal: la contraseña la genera el servidor (temporal) y se devuelve una sola vez. */
export class CreateStaffUserDto {
  @Transform(trim) @IsEmail() @MaxLength(254) email!: string;
  @Transform(trim) @IsString() @Length(1, 100) firstName!: string;
  @Transform(trim) @IsString() @Length(1, 100) lastName!: string;
  @IsOptional() @Matches(/^\+?[0-9]{7,15}$/, { message: 'phone debe tener de 7 a 15 dígitos, con "+" opcional' }) phone?: string;
  /** Códigos de rol de staff (admin, manager, seller, warehouse, support, logistics). */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @Matches(ROLE_CODE, { each: true, message: 'roles debe contener códigos de rol' })
  roles!: string[];
}
