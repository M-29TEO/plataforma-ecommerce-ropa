import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import { MAX_RATING_COMMENT, MAX_RATING_TAGS } from '../../domain/rating';
import { SETTLEMENT_STATUSES, SettlementStatus } from '../../domain/settlement';

const MONEY = /^\d{1,10}(\.\d{1,2})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class RateDeliveryDto {
  @IsInt() @Min(1) @Max(5) score!: number;
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_RATING_TAGS) @IsString({ each: true }) @Length(1, 40, { each: true }) tags?: string[];
  @IsOptional() @IsString() @MaxLength(MAX_RATING_COMMENT) comment?: string;
}

export class ListRatingsQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number = 20;
}

export class GenerateSettlementsDto {
  /** Lunes de la semana a liquidar; por defecto, la semana anterior. */
  @IsOptional() @Matches(DATE) periodStart?: string;
  @IsOptional() @IsBoolean() rebuildDisputed?: boolean;
}

export class ListSettlementsQuery {
  @IsOptional() @IsUUID() riderId?: string;
  @IsOptional() @IsIn(SETTLEMENT_STATUSES) status?: SettlementStatus;
  @IsOptional() @Matches(DATE) periodStart?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number = 50;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000) offset: number = 0;
}

export class ApproveSettlementDto {
  /** Efectivo contra entrega que el motorizado entregó al aprobar ("0.00" si no entregó nada). */
  @Matches(MONEY) codRemitted!: string;
}

export class DisputeSettlementDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(3, 500)
  reason!: string;
}
