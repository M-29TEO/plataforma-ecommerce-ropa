import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';

const REFUND_STATUSES = ['pending', 'processing', 'succeeded', 'failed'] as const;

export class ListRefundsQuery {
  /** "pending,processing" o status=pending&status=processing. */
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined ? undefined : (Array.isArray(value) ? value : String(value).split(',')).map((s) => String(s).trim()).filter(Boolean),
  )
  @IsArray()
  @ArrayMaxSize(REFUND_STATUSES.length)
  @IsIn(REFUND_STATUSES, { each: true })
  status?: (typeof REFUND_STATUSES)[number][];

  @IsOptional() @IsUUID() orderId?: string;
  @IsOptional() @IsUUID() returnId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number = 20;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000) offset: number = 0;
}

export class CompleteTransferRefundDto {
  @IsString() @Length(2, 80) bankName!: string;
  /** Número de comprobante de la transferencia al cliente. */
  @IsString() @Length(3, 80) reference!: string;
}
