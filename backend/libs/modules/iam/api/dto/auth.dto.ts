import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsDefined, IsEmail, IsJWT, IsOptional, IsString, Length, Matches, MaxLength, ValidateNested } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * Casillas del formulario de registro. Términos y privacidad deben venir en true (si no, 422
 * CONSENT_REQUIRED, lo decide el dominio); el marketing es opcional: lo que no venga no se registra.
 */
export class RegistrationConsentsDto {
  @IsBoolean() terms!: boolean;
  @IsBoolean() privacy!: boolean;
  @IsOptional() @IsBoolean() marketingEmail?: boolean;
  @IsOptional() @IsBoolean() marketingWhatsapp?: boolean;
  @IsOptional() @IsBoolean() marketingSms?: boolean;
}

/**
 * La longitud mínima de la contraseña la valida el dominio (422 PASSWORD_TOO_SHORT); aquí solo
 * el tipo y un tope generoso para no recibir cuerpos enormes.
 */
export class RegisterDto {
  @Transform(trim) @IsEmail() @MaxLength(254) email!: string;
  @IsString() @MaxLength(1024) password!: string;
  @IsString() @Length(1, 100) firstName!: string;
  @IsString() @Length(1, 100) lastName!: string;
  /** Celular o fijo: dígitos con "+" opcional (p. ej. 0991234567 o +593991234567). */
  @Matches(/^\+?[0-9]{7,15}$/, { message: 'phone debe tener de 7 a 15 dígitos, con "+" opcional' }) phone!: string;
  @IsDefined() @ValidateNested() @Type(() => RegistrationConsentsDto) consents!: RegistrationConsentsDto;
}

export class LoginDto {
  @Transform(trim) @IsEmail() @MaxLength(254) email!: string;
  @IsString() @MaxLength(1024) password!: string;
}

/** Código de 6 dígitos de la app autenticadora. */
export class MfaCodeDto {
  @Transform(trim) @Matches(/^\d{6}$/, { message: 'code debe tener 6 dígitos' }) code!: string;
}

/** mfaToken que devolvió el login (válido 5 min). */
export class MfaTokenDto {
  @IsJWT() mfaToken!: string;
}

export class MfaLoginDto extends MfaCodeDto {
  @IsJWT() mfaToken!: string;
}
