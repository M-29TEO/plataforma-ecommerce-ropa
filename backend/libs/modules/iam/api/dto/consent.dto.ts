import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsString, Length, ValidateNested } from 'class-validator';
import { CONSENT_PURPOSES, ConsentPurpose } from '../../domain/consent';

export class ConsentChangeDto {
  @IsIn(CONSENT_PURPOSES) purpose!: ConsentPurpose;
  @IsBoolean() granted!: boolean;
}

export class RecordConsentsDto {
  /** Versión de la política que el cliente vio al decidir (p. ej. "2026-09"). */
  @IsString() @Length(1, 40) policyVersion!: string;

  /** Un propósito una sola vez por pedido: si no, el orden decidiría cuál de las dos filas vale. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(CONSENT_PURPOSES.length)
  @ArrayUnique((c: ConsentChangeDto) => c?.purpose, { message: 'consents no puede repetir un propósito' })
  @ValidateNested({ each: true })
  @Type(() => ConsentChangeDto)
  consents!: ConsentChangeDto[];
}
