import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  ITEM_CONDITIONS,
  MAX_PHOTOS_PER_ITEM,
  REFUND_RESOLUTIONS,
  RETURN_REASON_CODES,
  RETURN_STATUSES,
  RETURN_TYPES,
} from '../../../orders';

const PHOTO_KEY = /^returns\/photos\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp)$/;

export class ReturnItemDto {
  @IsUUID() orderItemId!: string;
  @IsInt() @Min(1) @Max(1000) quantity!: number;
  @IsIn(RETURN_REASON_CODES) reasonCode!: (typeof RETURN_REASON_CODES)[number];
  /** Solo en cambios: la variante (otra talla del mismo producto). */
  @IsOptional() @IsUUID() exchangeVariantId?: string;
  /**
   * Claves que devolvió POST /me/returns/photos (returns/photos/<tenant>/<usuario>/<uuid>.<ext>).
   * El formato corta aquí un "../" o una clave de otro módulo; que sea del mismo cliente lo verifica el servicio.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_PHOTOS_PER_ITEM)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  @Matches(PHOTO_KEY, { each: true, message: 'photos: claves devueltas por POST /me/returns/photos' })
  photos?: string[];
}

export class CreateReturnDto {
  @IsIn(RETURN_TYPES) type!: (typeof RETURN_TYPES)[number];
  /** Solo devoluciones: refund_original (al medio de pago) o store_credit (saldo en gift card). */
  @IsOptional() @IsIn(REFUND_RESOLUTIONS) resolution?: (typeof REFUND_RESOLUTIONS)[number];
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  @IsOptional() @IsString() @MaxLength(1000) customerNotes?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => ReturnItemDto) items!: ReturnItemDto[];
}

/** Soporte registra la devolución en nombre del cliente (pedidos de invitado incluidos); sin fotos. */
export class RegisterReturnDto extends CreateReturnDto {
  @IsUUID() orderId!: string;
}

export class ListReturnsQuery {
  /** "requested,received" o status=requested&status=received. */
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined ? undefined : (Array.isArray(value) ? value : String(value).split(',')).map((s) => String(s).trim()).filter(Boolean),
  )
  @IsArray()
  @ArrayMaxSize(RETURN_STATUSES.length)
  @IsIn(RETURN_STATUSES, { each: true })
  status?: (typeof RETURN_STATUSES)[number][];

  @IsOptional() @IsUUID() orderId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number = 20;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000) offset: number = 0;
}

export class RejectReturnDto {
  @IsString() @Length(3, 500) reason!: string;
}

export class ReceiveReturnDto {
  /** Bodega que recibió el paquete, si no es la prevista en el retiro. */
  @IsOptional() @IsUUID() warehouseId?: string;
}

export class InspectionItemDto {
  @IsUUID() returnItemId!: string;
  @IsIn(ITEM_CONDITIONS) condition!: (typeof ITEM_CONDITIONS)[number];
  /** true: vuelve al stock vendible de la bodega que lo recibió. */
  @IsBoolean() restock!: boolean;
}

export class InspectReturnDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => InspectionItemDto) items!: InspectionItemDto[];
}
