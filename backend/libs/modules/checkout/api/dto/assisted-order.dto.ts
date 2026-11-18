import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
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
import { ASSISTED_PAYMENT_METHODS } from '../../domain/assisted-order';
import { AddressDto, BillingDto } from './checkout.dto';

const FULFILLMENT_TYPES = ['rider', 'courier', 'pickup'] as const;
const ID_TYPES = ['04', '05', '06'] as const;

export class SearchCustomersQuery {
  @IsString() @Length(2, 100) q!: string;
}

export class AssistedItemDto {
  @IsUUID() variantId!: string;
  /** CHECK de sales.order_items / límite del carrito: 1 a 20 unidades por línea. */
  @Type(() => Number) @IsInt() @Min(1) @Max(20) quantity!: number;
}

export class GeoPointDto {
  @IsLatitude() lat!: number;
  @IsLongitude() lng!: number;
}

export class AssistedFulfillmentDto {
  @IsIn(FULFILLMENT_TYPES) type!: (typeof FULFILLMENT_TYPES)[number];
  /** Dirección escrita por el vendedor (sin addressId). lat/lng aquí o en `location`. */
  @ValidateIf((o: AssistedFulfillmentDto) => o.type !== 'pickup' && !o.addressId)
  @ValidateNested()
  @Type(() => AddressDto)
  address?: AddressDto;
  @IsOptional() @ValidateNested() @Type(() => GeoPointDto) location?: GeoPointDto;
  /** Dirección guardada del cliente registrado (GET /assisted-orders/customers → addresses[].addressId). */
  @IsOptional() @IsUUID() addressId?: string;
  @ValidateIf((o: AssistedFulfillmentDto) => o.type === 'pickup') @IsUUID() pickupWarehouseId?: string;
}

export class AssistedCustomerGuestDto {
  @IsEmail() @MaxLength(254) email!: string;
  @IsString() @Length(1, 80) firstName!: string;
  @IsString() @Length(1, 80) lastName!: string;
  @Matches(/^\+?\d{7,15}$/) phone!: string;
  @IsOptional() @IsIn(ID_TYPES) idType?: (typeof ID_TYPES)[number];
  /** Con idType: 13 dígitos (RUC), 10 (cédula) o 5-20 letras y números (pasaporte); lo valida Facturación. */
  @ValidateIf((o: AssistedCustomerGuestDto) => o.idType !== undefined) @Matches(/^[A-Za-z0-9]{5,20}$/) idNumber?: string;
}

/** Exactamente uno: `userId` (cliente registrado) o `guest`. */
export class AssistedCustomerDto {
  @ValidateIf((o: AssistedCustomerDto) => !o.guest) @IsUUID() userId?: string;
  @ValidateIf((o: AssistedCustomerDto) => !o.userId) @ValidateNested() @Type(() => AssistedCustomerGuestDto) guest?: AssistedCustomerGuestDto;
}

export class AssistedQuoteDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => AssistedItemDto) items!: AssistedItemDto[];
  @IsOptional() @IsString() @Length(2, 40) couponCode?: string;
  @ValidateNested() @Type(() => AssistedFulfillmentDto) fulfillment!: AssistedFulfillmentDto;
  /** Opcional: promociones por cliente y límites de cupón. Debe ser el mismo que al crear el pedido. */
  @IsOptional() @ValidateNested() @Type(() => AssistedCustomerDto) customer?: AssistedCustomerDto;
}

export class AssistedOrderFulfillmentDto extends AssistedFulfillmentDto {
  /** options[].quoteId de POST /assisted-orders/quote (obligatorio salvo retiro en tienda). */
  @ValidateIf((o: AssistedOrderFulfillmentDto) => o.type !== 'pickup') @IsString() @Length(20, 4000) quoteToken?: string;
  /** options[].slots[].slotId (motorizado). */
  @IsOptional() @IsUUID() slotId?: string;
}

export class CreateAssistedOrderDto {
  @ValidateNested() @Type(() => AssistedCustomerDto) customer!: AssistedCustomerDto;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => AssistedItemDto) items!: AssistedItemDto[];
  @IsOptional() @IsString() @Length(2, 40) couponCode?: string;
  @ValidateNested() @Type(() => AssistedOrderFulfillmentDto) fulfillment!: AssistedOrderFulfillmentDto;
  @IsIn(ASSISTED_PAYMENT_METHODS) paymentMethod!: (typeof ASSISTED_PAYMENT_METHODS)[number];
  @IsOptional() @ValidateNested() @Type(() => BillingDto) billing?: BillingDto;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
  /** Total que vio el vendedor ("46.00"); si cambió, 409 CHECKOUT_TOTAL_CHANGED. */
  @IsOptional() @Matches(/^\d{1,10}(\.\d{1,2})?$/) expectedTotal?: string;
}

export class ListAssistedOrdersQuery {
  /** true (por defecto): solo los pedidos que tomó este vendedor. */
  @IsOptional() @Transform(({ value }) => (value === undefined ? undefined : value === true || value === 'true')) @IsBoolean() mine?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

/** Campos de texto del multipart del comprobante que sube el vendedor (el archivo va en "file"). */
export class StaffVoucherDto {
  /** Banco desde el que transfirió el cliente; si el vendedor no lo sabe, se omite. */
  @IsOptional() @IsString() @Length(2, 80) bankName?: string;
  @IsOptional() @IsString() @MaxLength(80) reference?: string;
}
