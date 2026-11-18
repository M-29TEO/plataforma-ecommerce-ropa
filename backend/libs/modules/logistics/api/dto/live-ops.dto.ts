import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { RIDER_PRESENCES, RiderPresence } from '../../domain/tracking';

/** Estados de logistics.shipments (CHECK del modelo de datos). */
export const SHIPMENT_STATUSES = [
  'pending',
  'ready_for_pickup',
  'assigned',
  'accepted',
  'picked_up',
  'in_transit',
  'arriving',
  'delivered',
  'failed_attempt',
  'returned_to_origin',
  'cancelled',
] as const;

export class ListShipmentsQuery {
  /** "pending,ready_for_pickup" o status=pending&status=ready_for_pickup. */
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined ? undefined : (Array.isArray(value) ? value : String(value).split(',')).map((s) => String(s).trim()).filter(Boolean),
  )
  @IsArray()
  @ArrayMaxSize(SHIPMENT_STATUSES.length)
  @IsIn(SHIPMENT_STATUSES, { each: true })
  status?: (typeof SHIPMENT_STATUSES)[number][];

  @IsOptional() @IsIn(['rider', 'courier', 'pickup']) carrierType?: 'rider' | 'courier' | 'pickup';
  @IsOptional() @IsUUID() zoneId?: string;
  @IsOptional() @IsUUID() riderId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number = 50;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100_000) offset: number = 0;
}

export class RiderPresenceDto {
  @IsIn(RIDER_PRESENCES) presence!: RiderPresence;
}
