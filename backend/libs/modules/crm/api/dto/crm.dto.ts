import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  registerDecorator,
  ValidateNested,
  ValidationOptions,
} from 'class-validator';

/** Teléfono tal como lo escribe el cliente; el dominio lo normaliza a dígitos (7 a 15). */
const PHONE = /^\+?[0-9 ()-]{7,20}$/;
/** Multiplicador de nivel como texto: hasta 2 enteros y 2 decimales ("1.25"). */
const MULTIPLIER = /^\d{1,2}(\.\d{1,2})?$/;
const MAX_BENEFITS_BYTES = 2048;

/**
 * Objeto JSON acotado en tamaño serializado. benefits se guarda tal cual en jsonb y se muestra en
 * el storefront: sin tope, un solo nivel podía meter megas en la base y en cada respuesta.
 */
function MaxJsonBytes(max: number, options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol) =>
    registerDecorator({
      name: 'maxJsonBytes',
      target: target.constructor,
      propertyName: String(propertyName),
      options: { message: `${String(propertyName)} no puede superar ${max} bytes en JSON`, ...options },
      validator: {
        validate(value: unknown): boolean {
          try {
            return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') <= max;
          } catch {
            return false;
          }
        },
      },
    });
}

export class PinDto {
  @IsLatitude() lat!: number;
  @IsLongitude() lng!: number;
}

/**
 * Campos de la dirección (crm.addresses). Largos y teléfono los valida también el dominio
 * (normalizeAddressFields); aquí solo tipos y topes para no aceptar cuerpos enormes.
 */
class AddressFieldsDto {
  @IsOptional() @IsString() @MaxLength(40) label?: string | null;
  @IsOptional() @IsString() @MaxLength(80) parish?: string | null;
  @IsOptional() @IsString() @MaxLength(120) neighborhood?: string | null;
  @IsOptional() @IsString() @MaxLength(200) crossStreet?: string | null;
  @IsOptional() @IsString() @MaxLength(20) houseNumber?: string | null;
  @IsOptional() @IsString() @MaxLength(300) reference?: string | null;
}

export class CreateAddressDto extends AddressFieldsDto {
  @IsString() @Length(2, 120) recipientName!: string;
  @IsString() @Matches(PHONE, { message: 'recipientPhone debe ser un teléfono' }) recipientPhone!: string;
  @IsString() @Length(2, 80) province!: string;
  @IsString() @Length(2, 80) city!: string;
  @IsString() @Length(2, 200) mainStreet!: string;
  /** Punto marcado en el mapa. Si llega, no se geocodifica (precisión user_pin). */
  @IsOptional() @ValidateNested() @Type(() => PinDto) pin?: PinDto;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

export class UpdateAddressDto extends AddressFieldsDto {
  @IsOptional() @IsString() @Length(2, 120) recipientName?: string;
  @IsOptional() @IsString() @Matches(PHONE, { message: 'recipientPhone debe ser un teléfono' }) recipientPhone?: string;
  @IsOptional() @IsString() @Length(2, 80) province?: string;
  @IsOptional() @IsString() @Length(2, 80) city?: string;
  @IsOptional() @IsString() @Length(2, 200) mainStreet?: string;
  @IsOptional() @ValidateNested() @Type(() => PinDto) pin?: PinDto;
}

export class GeocodePreviewDto extends AddressFieldsDto {
  @IsString() @Length(2, 80) province!: string;
  @IsString() @Length(2, 80) city!: string;
  @IsString() @Length(2, 200) mainStreet!: string;
}

export class AddToWishlistDto {
  @IsUUID() productId!: string;
  /** Talla/color que le interesa; sin ella se vigila el producto (cualquier talla). */
  @IsOptional() @IsUUID() variantId?: string;
  @IsOptional() @IsBoolean() notifyBackInStock?: boolean;
  @IsOptional() @IsBoolean() notifyPriceDrop?: boolean;
}

export class WishlistPreferencesDto {
  @IsOptional() @IsBoolean() notifyBackInStock?: boolean;
  @IsOptional() @IsBoolean() notifyPriceDrop?: boolean;
}

export class PageQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number = 50;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000) offset: number = 0;
}

export class RedeemPointsDto {
  @IsInt() @Min(1) @Max(10_000_000) points!: number;
}

export class AdjustPointsDto {
  @IsInt() @Min(-1_000_000) @Max(1_000_000) points!: number;
  @IsString() @Length(3, 300) reason!: string;
}

export class ApplyReferralDto {
  @IsString() @Matches(/^[A-Z0-9-]{3,40}$/i, { message: 'code no es un código de referido' }) code!: string;
}

export class CreateTierDto {
  @IsString() @Length(2, 40) name!: string;
  @IsInt() @Min(0) @Max(10_000_000) minPoints!: number;
  /** "1.25" (texto, para no perder precisión). El rango 1.00–10.00 lo valida el dominio. */
  @IsString() @Matches(MULTIPLIER, { message: 'multiplier debe tener hasta 2 decimales (por ejemplo 1.25)' }) multiplier!: string;
  @IsOptional() @IsObject() @MaxJsonBytes(MAX_BENEFITS_BYTES) benefits?: Record<string, unknown>;
}

export class UpdateTierDto {
  @IsOptional() @IsString() @Length(2, 40) name?: string;
  @IsOptional() @IsInt() @Min(0) @Max(10_000_000) minPoints?: number;
  @IsOptional() @IsString() @Matches(MULTIPLIER, { message: 'multiplier debe tener hasta 2 decimales (por ejemplo 1.25)' }) multiplier?: string;
  @IsOptional() @IsObject() @MaxJsonBytes(MAX_BENEFITS_BYTES) benefits?: Record<string, unknown>;
}
