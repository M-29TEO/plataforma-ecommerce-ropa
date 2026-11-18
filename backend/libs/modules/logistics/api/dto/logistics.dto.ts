import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { DELIVERY_MODES, DeliveryMode } from '../../domain/zone';
import { IsBoundedGeoJsonArea } from './geojson-area.validator';

const MONEY = /^\d{1,10}(\.\d{1,2})?$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const ToBoolean = () => Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value));

export class CreateZoneDto {
  @IsString() @Length(2, 120) name!: string;
  @IsString() @Length(2, 80) city!: string;
  /** GeoJSON Polygon, MultiPolygon o Feature (coordenadas [longitud, latitud]). */
  @IsBoundedGeoJsonArea() area!: Record<string, unknown>;
  @IsIn(DELIVERY_MODES) deliveryMode!: DeliveryMode;
  @IsOptional() @IsInt() @Min(0) @Max(10_000) priority?: number;
  @Matches(MONEY) baseFee!: string;
  @IsOptional() @Matches(MONEY) feePerKm?: string;
  @IsOptional() @Matches(MONEY) feePerExtraKg?: string;
  @IsOptional() @IsNumber() @Min(0.1) @Max(1000) maxWeightKg?: number;
  @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(MONEY) freeShippingThreshold?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(TIME) sameDayCutoff?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() servingWarehouseId?: string | null;
}

export class UpdateZoneDto {
  @IsOptional() @IsString() @Length(2, 120) name?: string;
  @IsOptional() @IsString() @Length(2, 80) city?: string;
  @IsOptional() @IsBoundedGeoJsonArea() area?: Record<string, unknown>;
  @IsOptional() @IsIn(DELIVERY_MODES) deliveryMode?: DeliveryMode;
  @IsOptional() @IsInt() @Min(0) @Max(10_000) priority?: number;
  @IsOptional() @Matches(MONEY) baseFee?: string;
  @IsOptional() @Matches(MONEY) feePerKm?: string;
  @IsOptional() @Matches(MONEY) feePerExtraKg?: string;
  @IsOptional() @IsNumber() @Min(0.1) @Max(1000) maxWeightKg?: number;
  @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(MONEY) freeShippingThreshold?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(TIME) sameDayCutoff?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() servingWarehouseId?: string | null;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class ListZonesQuery {
  @IsOptional() @ToBoolean() @IsBoolean() active?: boolean;
  @IsOptional() @IsString() @MaxLength(80) city?: string;
}

export class PointQuery {
  @Type(() => Number) @IsNumber() @Min(-90) @Max(90) lat!: number;
  @Type(() => Number) @IsNumber() @Min(-180) @Max(180) lng!: number;
}

export class CreateSlotTemplateDto {
  /** 0 = domingo … 6 = sábado. */
  @IsInt() @Min(0) @Max(6) weekday!: number;
  @Matches(TIME) startTime!: string;
  @Matches(TIME) endTime!: string;
  @IsInt() @Min(0) @Max(10_000) capacity!: number;
  @IsOptional() @Matches(MONEY) surcharge?: string;
}

export class UpdateSlotTemplateDto {
  @IsOptional() @IsInt() @Min(0) @Max(6) weekday?: number;
  @IsOptional() @Matches(TIME) startTime?: string;
  @IsOptional() @Matches(TIME) endTime?: string;
  @IsOptional() @IsInt() @Min(0) @Max(10_000) capacity?: number;
  @IsOptional() @Matches(MONEY) surcharge?: string;
}

export class ListSlotsQuery {
  @IsOptional() @Matches(DATE) from?: string;
  @IsOptional() @Matches(DATE) to?: string;
}

export class UpdateSlotCapacityDto {
  @IsInt() @Min(0) @Max(10_000) capacity!: number;
}

export class QuoteDestinationDto {
  @IsNumber() @Min(-90) @Max(90) lat!: number;
  @IsNumber() @Min(-180) @Max(180) lng!: number;
  @IsString() @Length(2, 80) city!: string;
  @IsOptional() @IsString() @Length(2, 80) province?: string;
}

/** Cotización directa (backoffice / demo), sin carrito: peso y total explícitos. */
export class StaffQuoteDto {
  @ValidateNested() @Type(() => QuoteDestinationDto) destination!: QuoteDestinationDto;
  @IsInt() @Min(1) @Max(1_000_000) weightG!: number;
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) volumeCm3?: number;
  @IsOptional() @Matches(MONEY) merchandiseTotal?: string;
}
