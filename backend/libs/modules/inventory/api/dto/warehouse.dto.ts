import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { WAREHOUSE_TYPES, WarehouseType } from '../../domain/warehouse';
import { ToBoolean } from './common';

export class GeoPointDto {
  @IsNumber() @Min(-90) @Max(90) lat!: number;
  @IsNumber() @Min(-180) @Max(180) lng!: number;
}

/**
 * Dirección de la bodega (se guarda como jsonb y se copia en guías, facturas y devoluciones).
 * Antes era un objeto libre: cualquier clave y tamaño terminaba en la base y en los documentos.
 */
export class WarehouseAddressDto {
  @IsString() @Length(2, 200) mainStreet!: string;
  @IsOptional() @IsString() @MaxLength(200) secondaryStreet?: string;
  @IsOptional() @IsString() @MaxLength(20) number?: string;
  @IsOptional() @IsString() @MaxLength(120) neighborhood?: string;
  @IsOptional() @IsString() @MaxLength(80) parish?: string;
  @IsOptional() @IsString() @MaxLength(80) city?: string;
  @IsOptional() @IsString() @MaxLength(80) province?: string;
  @IsOptional() @IsString() @MaxLength(10) postalCode?: string;
  @IsOptional() @IsString() @MaxLength(300) reference?: string;
  @IsOptional() @IsNumber() @Min(-90) @Max(90) lat?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) lng?: number;
}

export class CreateWarehouseDto {
  @IsString() @Length(2, 20) code!: string;
  @IsString() @Length(1, 120) name!: string;
  @IsIn(WAREHOUSE_TYPES) type!: WarehouseType;
  /** Dirección estructurada: calle principal, secundaria, número, referencia, provincia... */
  @ValidateNested() @Type(() => WarehouseAddressDto) address!: WarehouseAddressDto;
  @ValidateNested() @Type(() => GeoPointDto) location!: GeoPointDto;
  @IsString() @Length(1, 80) city!: string;
  @IsOptional() @IsBoolean() isPickupPoint?: boolean;
  @IsOptional() @IsBoolean() shipsOnline?: boolean;
}

/** El código no se edita: aparece en etiquetas, reportes y referencias externas. */
export class UpdateWarehouseDto {
  @IsOptional() @IsString() @Length(1, 120) name?: string;
  @IsOptional() @IsIn(WAREHOUSE_TYPES) type?: WarehouseType;
  @IsOptional() @ValidateNested() @Type(() => WarehouseAddressDto) address?: WarehouseAddressDto;
  @IsOptional() @ValidateNested() @Type(() => GeoPointDto) location?: GeoPointDto;
  @IsOptional() @IsString() @Length(1, 80) city?: string;
  @IsOptional() @IsBoolean() isPickupPoint?: boolean;
  @IsOptional() @IsBoolean() shipsOnline?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class ListWarehousesQuery {
  @IsOptional() @ToBoolean() @IsBoolean() active?: boolean;
  @IsOptional() @IsString() @MaxLength(80) city?: string;
  @IsOptional() @IsIn(WAREHOUSE_TYPES) type?: WarehouseType;
}

export class NearbyWarehousesQuery {
  @Type(() => Number) @IsNumber() @Min(-90) @Max(90) lat!: number;
  @Type(() => Number) @IsNumber() @Min(-180) @Max(180) lng!: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0.1) @Max(500) radiusKm: number = 10;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit: number = 10;
}
