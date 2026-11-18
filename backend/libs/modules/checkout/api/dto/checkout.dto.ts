import { Type } from 'class-transformer';
import {
  IsDefined,
  IsEmail,
  IsIn,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  Validate,
  ValidateIf,
  ValidateNested,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { CHECKOUT_PAYMENT_METHODS } from '../../domain/checkout';

const FULFILLMENT_TYPES = ['rider', 'courier', 'pickup'] as const;
/** SRI: 04 RUC, 05 cédula, 06 pasaporte. */
const ID_TYPES = ['04', '05', '06'] as const;

/** Formato por tipo; el dígito verificador de cédula y RUC lo valida Facturación (422 INVALID_BUYER_ID). */
const ID_FORMAT: Record<(typeof ID_TYPES)[number], RegExp> = {
  '04': /^\d{13}$/,
  '05': /^\d{10}$/,
  '06': /^[A-Za-z0-9]{5,20}$/,
};
/** Sin idType (datos del cliente) solo se acota a letras y números. */
const ANY_ID = /^[A-Za-z0-9]{5,20}$/;

/** idNumber acorde a idType del mismo objeto: 13 dígitos (RUC), 10 (cédula) o 5-20 alfanuméricos (pasaporte). */
@ValidatorConstraint({ name: 'idNumberForType' })
class IdNumberForType implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    if (typeof value !== 'string') return false;
    const idType = (args.object as { idType?: string }).idType;
    const format = idType && idType in ID_FORMAT ? ID_FORMAT[idType as (typeof ID_TYPES)[number]] : ANY_ID;
    return format.test(value);
  }

  defaultMessage(): string {
    return 'idNumber: RUC de 13 dígitos, cédula de 10 o pasaporte de 5 a 20 letras y números';
  }
}

export class CustomerDto {
  @IsString() @Length(2, 120) name!: string;
  @IsEmail() @MaxLength(254) email!: string;
  @IsOptional() @Matches(/^\+?\d{7,15}$/) phone?: string;
  @IsOptional() @IsIn(ID_TYPES) idType?: (typeof ID_TYPES)[number];
  @IsOptional() @IsString() @Validate(IdNumberForType) idNumber?: string;
}

export class AddressDto {
  @IsString() @Length(2, 200) mainStreet!: string;
  @IsOptional() @IsString() @MaxLength(200) secondaryStreet?: string;
  @IsOptional() @IsString() @MaxLength(20) number?: string;
  @IsOptional() @IsString() @MaxLength(300) reference?: string;
  @IsString() @Length(2, 80) city!: string;
  @IsOptional() @IsString() @MaxLength(80) province?: string;
  /** Barrio o sector: lo usa Reportes (ventas por barrio). */
  @IsOptional() @IsString() @MaxLength(120) neighborhood?: string;
  /** Obligatorias para entregar a domicilio: con ellas se resuelve la zona y se cotiza. */
  @IsOptional() @IsLatitude() lat?: number;
  @IsOptional() @IsLongitude() lng?: number;
}

/**
 * Dirección para cotizar: el punto en el mapa es obligatorio. Clase aparte (no extiende AddressDto)
 * porque class-validator hereda el @IsOptional de lat/lng.
 */
export class DeliveryAddressDto {
  @IsString() @Length(2, 200) mainStreet!: string;
  @IsOptional() @IsString() @MaxLength(200) secondaryStreet?: string;
  @IsOptional() @IsString() @MaxLength(20) number?: string;
  @IsOptional() @IsString() @MaxLength(300) reference?: string;
  @IsString() @Length(2, 80) city!: string;
  @IsOptional() @IsString() @MaxLength(80) province?: string;
  @IsLatitude() lat!: number;
  @IsLongitude() lng!: number;
}

export class DeliveryOptionsDto {
  // IsDefined: ValidateNested deja pasar undefined y un cuerpo vacío terminaba en 500.
  @ValidateIf((o: DeliveryOptionsDto) => !o.addressId) @IsDefined() @ValidateNested() @Type(() => DeliveryAddressDto) shippingAddress?: DeliveryAddressDto;
  /** Dirección guardada del cliente (GET /me/addresses) en lugar de shippingAddress. Requiere sesión. */
  @IsOptional() @IsUUID() addressId?: string;
}

export class BillingDto {
  @IsString() @Length(2, 200) name!: string;
  @IsIn(ID_TYPES) idType!: (typeof ID_TYPES)[number];
  @IsString() @Validate(IdNumberForType) idNumber!: string;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @IsString() @MaxLength(300) address?: string;
}

export class CheckoutDto {
  @ValidateNested() @Type(() => CustomerDto) customer!: CustomerDto;
  @IsOptional() @ValidateNested() @Type(() => BillingDto) billing?: BillingDto;

  @IsIn(FULFILLMENT_TYPES) fulfillmentType!: (typeof FULFILLMENT_TYPES)[number];
  @ValidateIf((o: CheckoutDto) => o.fulfillmentType !== 'pickup' && !o.addressId)
  @IsDefined()
  @ValidateNested()
  @Type(() => AddressDto)
  shippingAddress?: AddressDto;
  /** Dirección guardada del cliente en lugar de shippingAddress (debe tener ubicación). Requiere sesión. */
  @IsOptional() @IsUUID() addressId?: string;
  @ValidateIf((o: CheckoutDto) => o.fulfillmentType === 'pickup') @IsUUID() pickupWarehouseId?: string;
  /** `options[].quoteId` de POST /checkout/delivery-options (motorizado o courier). */
  @ValidateIf((o: CheckoutDto) => o.fulfillmentType !== 'pickup') @IsString() @Length(20, 4000) deliveryQuoteId?: string;
  /** `options[].slots[].slotId` (solo motorizado). */
  @IsOptional() @IsUUID() deliverySlotId?: string;

  @IsIn(CHECKOUT_PAYMENT_METHODS) paymentMethod!: (typeof CHECKOUT_PAYMENT_METHODS)[number];
  @IsOptional() @IsString() @Length(4, 40) giftCardCode?: string;
  /** Total que ve el cliente ("46.00"); si cambió, 409 CHECKOUT_TOTAL_CHANGED. */
  @IsOptional() @Matches(/^\d{1,10}(\.\d{1,2})?$/) expectedTotal?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @IsOptional() @IsIn(['web', 'app']) channel?: 'web' | 'app';
}
