import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsEmail,
  IsIn,
  IsInt,
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
  ValidateIf,
  ValidationOptions,
} from 'class-validator';
import { PROMOTION_TYPES, PromotionType } from '../../domain/promotion';

const MONEY = /^\d{1,10}(\.\d{1,2})?$/;
const ToBoolean = () => Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value));

interface JsonLimits {
  maxBytes: number;
  maxDepth: number;
}

/**
 * conditions admite hasta 500 ids por lista en el dominio (≈ 20 KB de UUIDs): 32 KB los cubre.
 * La profundidad real es 2 (objeto → lista → id).
 */
const CONDITIONS_LIMITS: JsonLimits = { maxBytes: 32 * 1024, maxDepth: 3 };
/** benefit más profundo: tiered (objeto → tiers → tramo); como mucho 20 tramos. */
const BENEFIT_LIMITS: JsonLimits = { maxBytes: 4 * 1024, maxDepth: 3 };

/** Corta al pasar el máximo: un cuerpo anidado miles de niveles no llega a agotar la pila. */
function deeperThan(value: unknown, maxDepth: number): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (maxDepth <= 0) return true;
  return Object.values(value).some((v) => deeperThan(v, maxDepth - 1));
}

/**
 * Cota de tamaño y profundidad para un jsonb libre. El dominio valida cada campo, pero antes
 * de llegar ahí un objeto enorme o muy anidado cuesta CPU en la validación y espacio en la base.
 */
function BoundedJson(limits: JsonLimits, options?: ValidationOptions): PropertyDecorator {
  return (target, propertyName) =>
    registerDecorator({
      name: 'boundedJson',
      target: target.constructor,
      propertyName: propertyName as string,
      options: { message: `$property: máximo ${limits.maxBytes} bytes y ${limits.maxDepth} niveles de anidación`, ...options },
      validator: {
        validate(value: unknown): boolean {
          if (value === undefined || value === null) return true;
          // La profundidad primero: así JSON.stringify nunca recorre una estructura patológica.
          if (deeperThan(value, limits.maxDepth)) return false;
          return Buffer.byteLength(JSON.stringify(value), 'utf8') <= limits.maxBytes;
        },
      },
    });
}

/**
 * conditions y benefit son jsonb polimórficos (dependen del tipo): aquí solo se exige que sean
 * objetos; el dominio (validatePromotionDefinition) valida cada campo y rechaza los desconocidos.
 */
export class CreatePromotionDto {
  @IsString() @Length(1, 200) name!: string;
  @IsIn(PROMOTION_TYPES) type!: PromotionType;
  @IsOptional() @IsObject() @BoundedJson(CONDITIONS_LIMITS) conditions?: Record<string, unknown>;
  @IsObject() @BoundedJson(BENEFIT_LIMITS) benefit!: Record<string, unknown>;
  @IsOptional() @IsBoolean() requiresCoupon?: boolean;
  @IsOptional() @IsBoolean() stackable?: boolean;
  /** Menor = se evalúa primero. */
  @IsOptional() @IsInt() @Min(0) @Max(10_000) priority?: number;
  /** null = sin límite. */
  @IsOptional() @ValidateIf((o) => o.maxUses !== null) @IsInt() @Min(1) @Max(1_000_000) maxUses?: number | null;
  @Type(() => Date) @IsDate() startsAt!: Date;
  @IsOptional() @ValidateIf((o) => o.endsAt !== null) @Type(() => Date) @IsDate() endsAt?: Date | null;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class UpdatePromotionDto {
  @IsOptional() @IsString() @Length(1, 200) name?: string;
  @IsOptional() @IsObject() @BoundedJson(CONDITIONS_LIMITS) conditions?: Record<string, unknown>;
  @IsOptional() @IsObject() @BoundedJson(BENEFIT_LIMITS) benefit?: Record<string, unknown>;
  @IsOptional() @IsBoolean() requiresCoupon?: boolean;
  @IsOptional() @IsBoolean() stackable?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(10_000) priority?: number;
  @IsOptional() @ValidateIf((o) => o.maxUses !== null) @IsInt() @Min(1) @Max(1_000_000) maxUses?: number | null;
  @IsOptional() @Type(() => Date) @IsDate() startsAt?: Date;
  @IsOptional() @ValidateIf((o) => o.endsAt !== null) @Type(() => Date) @IsDate() endsAt?: Date | null;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class ListPromotionsQuery {
  @IsOptional() @ToBoolean() @IsBoolean() active?: boolean;
  @IsOptional() @IsIn(PROMOTION_TYPES) type?: PromotionType;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number = 50;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000) offset: number = 0;
}

export class CreateCouponDto {
  @Matches(/^[A-Za-z0-9_-]{3,40}$/, { message: 'code: de 3 a 40 letras, números, "-" o "_"' }) code!: string;
  @IsOptional() @ValidateIf((o) => o.maxUses !== null) @IsInt() @Min(1) @Max(1_000_000) maxUses?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(1000) maxUsesPerCustomer?: number;
  /** Cupón personal: solo ese cliente puede usarlo. */
  @IsOptional() @IsUUID() assignedUserId?: string;
}

export class IssueGiftCardDto {
  @Matches(MONEY, { message: 'amount debe ser un monto con máximo 2 decimales' }) amount!: string;
  @IsOptional() @IsEmail() @MaxLength(254) recipientEmail?: string;
  @IsOptional() @IsUUID() purchaserId?: string;
  @IsOptional() @Type(() => Date) @IsDate() expiresAt?: Date;
  /** true = queda 'pending' hasta activarla (venta en línea que aún no se paga). */
  @IsOptional() @IsBoolean() pending?: boolean;
}

export class AdjustGiftCardDto {
  /** Con signo: "-5.00" resta, "10.00" suma. */
  @Matches(/^-?\d{1,10}(\.\d{1,2})?$/, { message: 'delta debe ser un monto con signo opcional y máximo 2 decimales' })
  delta!: string;
}

export class GiftCardBalanceDto {
  @IsString() @Length(4, 40) code!: string;
}

const GIFT_CARD_STATUSES = ['pending', 'active', 'depleted', 'expired', 'blocked'] as const;

export class ListGiftCardsQuery {
  @IsOptional() @IsIn(GIFT_CARD_STATUSES) status?: (typeof GIFT_CARD_STATUSES)[number];
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number = 50;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000) offset: number = 0;
}
