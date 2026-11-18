import { Type } from 'class-transformer';
import {
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
  NotEquals,
  ValidateIf,
} from 'class-validator';

/** Tope de cantidades: un dedazo (un cero de más) no debe llegar al ledger ni desbordar el int. */
const MAX_QTY = 1_000_000;
const MAX_DELTA = 100_000;
import { ToBoolean } from './common';

export class ListStockQuery {
  @IsOptional() @IsUUID() warehouseId?: string;
  @IsOptional() @IsUUID() variantId?: string;
  @IsOptional() @ToBoolean() @IsBoolean() belowReorderPoint?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit: number = 50;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000) offset: number = 0;
}

export class UpdateStockSettingsDto {
  /** Versión leída por el cliente (concurrencia optimista). */
  @IsInt() @Min(0) version!: number;
  @IsOptional() @IsInt() @Min(0) @Max(MAX_QTY) reorderPoint?: number;
  @IsOptional() @IsInt() @Min(1) @Max(MAX_QTY) reorderQty?: number;
  @IsOptional() @IsString() @MaxLength(40) binLocation?: string | null;
}

export const ADJUSTMENT_TYPES = ['adjustment', 'damage', 'count'] as const;

/**
 * - adjustment: delta con signo (+3 encontradas, -2 faltantes).
 * - damage: unidades dañadas (siempre salen).
 * - count: conteo físico; el sistema calcula el delta contra on_hand.
 */
export class AdjustStockDto {
  @IsUUID() variantId!: string;
  @IsUUID() warehouseId!: string;
  @IsIn(ADJUSTMENT_TYPES) type!: (typeof ADJUSTMENT_TYPES)[number];

  @ValidateIf((o: AdjustStockDto) => o.type === 'adjustment')
  @IsInt()
  @Min(-MAX_DELTA)
  @Max(MAX_DELTA)
  @NotEquals(0, { message: 'delta no puede ser 0' })
  delta?: number;
  @ValidateIf((o: AdjustStockDto) => o.type === 'damage') @IsInt() @Min(1) @Max(MAX_QTY) quantity?: number;
  @ValidateIf((o: AdjustStockDto) => o.type === 'count') @IsInt() @Min(0) @Max(MAX_QTY) countedQuantity?: number;

  @IsString() @Length(3, 500) reason!: string;
}

export class ListMovementsQuery {
  @IsOptional() @IsUUID() variantId?: string;
  @IsOptional() @IsUUID() warehouseId?: string;
  /** Paginación por cursor: id del último movimiento recibido. */
  @IsOptional() @Matches(/^\d{1,19}$/) beforeId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit: number = 50;
}

export class ListReservationsQuery {
  @IsUUID() orderId!: string;
}
