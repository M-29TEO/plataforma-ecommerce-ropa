import { IsEmail, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { MAX_QTY_PER_LINE } from '../../domain/cart';

export class AddItemDto {
  @IsUUID() variantId!: string;
  @IsInt() @Min(1) @Max(MAX_QTY_PER_LINE) quantity!: number;
}

export class SetQuantityDto {
  @IsInt() @Min(1) @Max(MAX_QTY_PER_LINE) quantity!: number;
}

/** Mismo formato que acepta Promociones (normalizeCouponCode: se compara en mayúsculas). */
const COUPON_CODE = /^[A-Za-z0-9_-]{3,40}$/;
const COUPON_MESSAGE = 'code: de 3 a 40 letras, números, "-" o "_"';

export class ApplyCouponDto {
  @Matches(COUPON_CODE, { message: COUPON_MESSAGE }) code!: string;
}

/** DELETE /cart/coupons/:code: un código mal formado responde 400 antes de tocar el carrito. */
export class CouponCodeParam {
  @Matches(COUPON_CODE, { message: COUPON_MESSAGE }) code!: string;
}

export class ContactDto {
  /** null borra el dato. */
  @IsOptional() @ValidateIf((o) => o.email !== null) @IsEmail() @MaxLength(254) email?: string | null;
  @IsOptional() @ValidateIf((o) => o.phone !== null) @IsString() @Matches(/^\+?[0-9 ()-]{7,20}$/, { message: 'phone: de 7 a 20 dígitos, espacios, paréntesis o "-"' }) phone?: string | null;
}
