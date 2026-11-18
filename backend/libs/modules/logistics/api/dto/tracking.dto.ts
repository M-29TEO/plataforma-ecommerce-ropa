import { Type } from 'class-transformer';
import { IsDate, IsIn, IsInt, IsLatitude, IsLongitude, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { COD_METHODS, CodMethod } from '../../domain/delivery-proof';
import { RIDER_SETTABLE_STATUSES, RiderSettableStatus } from '../../domain/tracking';

/** randomBytes(18).toString('base64url') = 24 caracteres; se acepta un margen por si cambia el largo. */
export class TrackingTokenParam {
  @Matches(/^[A-Za-z0-9_-]{16,64}$/) token!: string;
}

export class AssignRiderDto {
  @IsUUID() riderId!: string;
}

export class RiderPositionDto {
  @IsLatitude() lat!: number;
  @IsLongitude() lng!: number;
  @IsOptional() @IsInt() @Min(0) @Max(359) heading?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(200) speedKmh?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(5000) accuracyM?: number;
  /** Hora del GPS (ISO); por defecto, la de llegada. */
  @IsOptional() @Type(() => Date) @IsDate() recordedAt?: Date;
}

export class RiderStatusDto {
  @IsIn(RIDER_SETTABLE_STATUSES) status!: RiderSettableStatus;
  @IsOptional() @IsLatitude() lat?: number;
  @ValidateIf((o: RiderStatusDto) => o.lat !== undefined) @IsLongitude() lng?: number;
  /** Intento fallido: motivo (queda como descripción del evento que ve el cliente). */
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
}

/**
 * Entrega (multipart/form-data: los campos llegan como texto, de ahí los @Type). Los archivos
 * (photo, signature) los valida el dominio por magic bytes.
 */
export class DeliverDto {
  @Type(() => Number) @IsLatitude() lat!: number;
  @Type(() => Number) @IsLongitude() lng!: number;
  /** Quien recibió (el titular o alguien en el domicilio). */
  @IsString() @Length(2, 120) receiverName!: string;
  /** Código de entrega que dicta el cliente (obligatorio si el envío lo tiene). */
  @IsOptional() @Type(() => String) @Matches(/^\d{4}$/,{ message: 'otp debe tener 4 dígitos' }) otp?: string;
  /** Contra entrega: lo cobrado, exactamente el monto del envío. */
  @IsOptional() @Type(() => String) @Matches(/^\d{1,8}(\.\d{1,2})?$/,{ message: 'codCollected debe ser un monto (por ejemplo 34.50)' }) codCollected?: string;
  @IsOptional() @IsIn(COD_METHODS) codMethod?: CodMethod;
}
