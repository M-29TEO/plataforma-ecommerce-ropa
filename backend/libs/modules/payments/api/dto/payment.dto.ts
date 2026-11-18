import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min } from 'class-validator';
import { PAYMENT_METHODS } from '../../domain/payment';

const PAYMENT_STATUSES = [
  'pending',
  'requires_action',
  'authorized',
  'captured',
  'failed',
  'cancelled',
  'expired',
  'refunded',
  'partially_refunded',
] as const;

export class ListPaymentsQuery {
  /** "pending,requires_action" o status=pending&status=requires_action. */
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined ? undefined : (Array.isArray(value) ? value : String(value).split(',')).map((s) => String(s).trim()).filter(Boolean),
  )
  @IsArray()
  @ArrayMaxSize(PAYMENT_STATUSES.length)
  @IsIn(PAYMENT_STATUSES, { each: true })
  status?: (typeof PAYMENT_STATUSES)[number][];

  @IsOptional() @IsIn(PAYMENT_METHODS) method?: (typeof PAYMENT_METHODS)[number];
  @IsOptional() @IsUUID() orderId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number = 20;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000) offset: number = 0;
}

/** Campos de texto del multipart del comprobante (el archivo va en el campo "voucher"). */
export class SubmitVoucherDto {
  @IsString() @Length(2, 80) bankName!: string;
  @IsOptional() @IsString() @MaxLength(80) reference?: string;
}

export class RejectTransferDto {
  @IsString() @Length(3, 500) reason!: string;
}
