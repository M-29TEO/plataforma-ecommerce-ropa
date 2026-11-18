import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDate,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { FULFILLMENT_TYPES, MANUAL_STATUSES, ManualOrderStatus, ORDER_STATUSES, PAYMENT_METHODS } from '../../domain/order-status';

const PAYMENT_STATUSES = ['pending', 'authorized', 'paid', 'cod_pending', 'partially_refunded', 'refunded', 'failed'] as const;
const CHANNELS = ['web', 'app', 'whatsapp', 'backoffice', 'store'] as const;

/** "created,paid" o status=created&status=paid → ['created', 'paid']. */
const ToStringArray = () =>
  Transform(({ value }) =>
    value === undefined ? undefined : (Array.isArray(value) ? value : String(value).split(',')).map((s) => String(s).trim()).filter(Boolean),
  );

/** Rango máximo de un listado por fechas: un año (bisiesto incluido). */
const MAX_RANGE_MS = 366 * 24 * 3_600_000;

/**
 * from <= to y como mucho 366 días entre ambos: un rango de años obliga a recorrer media tabla
 * de pedidos con cada página. Solo aplica con los dos extremos (con uno solo el filtro es abierto).
 */
@ValidatorConstraint({ name: 'dateRange' })
class DateRangeConstraint implements ValidatorConstraintInterface {
  validate(to: unknown, args: ValidationArguments): boolean {
    const from = (args.object as { from?: unknown }).from;
    if (!(to instanceof Date) || !(from instanceof Date)) return true;
    const span = to.getTime() - from.getTime();
    return span >= 0 && span <= MAX_RANGE_MS;
  }

  defaultMessage(): string {
    return 'from debe ser anterior a to y el rango no puede superar 366 días';
  }
}

class PaginationQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number = 20;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000) offset: number = 0;
}

export class MyOrdersQuery extends PaginationQuery {
  @IsOptional() @ToStringArray() @IsArray() @ArrayMaxSize(ORDER_STATUSES.length) @IsIn(ORDER_STATUSES, { each: true })
  status?: (typeof ORDER_STATUSES)[number][];
}

export class ListOrdersQuery extends MyOrdersQuery {
  @IsOptional() @IsIn(PAYMENT_STATUSES) paymentStatus?: (typeof PAYMENT_STATUSES)[number];
  @IsOptional() @IsIn(PAYMENT_METHODS) paymentMethod?: (typeof PAYMENT_METHODS)[number];
  @IsOptional() @IsIn(FULFILLMENT_TYPES) fulfillmentType?: (typeof FULFILLMENT_TYPES)[number];
  @IsOptional() @IsIn(CHANNELS) channel?: (typeof CHANNELS)[number];
  @IsOptional() @IsUUID() userId?: string;
  /** ISO 8601. Rango [from, to) sobre placed_at. */
  @IsOptional() @Type(() => Date) @IsDate() from?: Date;
  @IsOptional() @Type(() => Date) @IsDate() @Validate(DateRangeConstraint) to?: Date;
  /** Número de pedido o parte del email del cliente. */
  @IsOptional() @IsString() @Length(1, 120) q?: string;
}

export class ChangeStatusDto {
  /** Las devoluciones (partially_returned, returned) las registra el flujo de devoluciones. */
  @IsIn(MANUAL_STATUSES) to!: ManualOrderStatus;
  /** Versión leída por el cliente (concurrencia optimista). */
  @IsInt() @Min(0) @Max(2_147_483_647) version!: number;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class CancelMyOrderDto {
  @IsInt() @Min(0) @Max(2_147_483_647) version!: number;
  @IsString() @Length(3, 500) reason!: string;
}
