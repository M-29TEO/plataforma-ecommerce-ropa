import { Equals, IsString, MaxLength, MinLength } from 'class-validator';

export const ANONYMIZE_CONFIRMATION = 'ELIMINAR MI CUENTA';

/** La frase evita un clic accidental; la contraseña, que baste con un token robado. */
export class AnonymizeAccountDto {
  @IsString() @MinLength(1) @MaxLength(200) password!: string;
  @Equals(ANONYMIZE_CONFIRMATION, { message: `confirm debe ser exactamente "${ANONYMIZE_CONFIRMATION}"` }) confirm!: string;
}
