import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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
  ValidateNested,
} from 'class-validator';

const PO_STATUSES = ['draft', 'sent', 'partially_received', 'received', 'cancelled'] as const;

export class PurchaseOrderItemDto {
  @IsUUID() variantId!: string;
  @IsInt() @Min(1) @Max(100_000) qtyOrdered!: number;
  /** Costo unitario en USD como texto para no perder precisión: "12.50". */
  @Matches(/^\d{1,10}(\.\d{1,2})?$/, { message: 'unitCost debe ser un monto con hasta 2 decimales' })
  unitCost!: string;
}

export class CreatePurchaseOrderDto {
  @IsUUID() supplierId!: string;
  @IsUUID() warehouseId!: string;
  @IsOptional() @IsString() @Length(1, 40) number?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'expectedAt debe tener formato AAAA-MM-DD' })
  expectedAt?: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderItemDto)
  items!: PurchaseOrderItemDto[];
}

export class ReceiptLineDto {
  @IsUUID() itemId!: string;
  @IsInt() @Min(1) @Max(100_000) quantity!: number;
}

export class ReceivePurchaseOrderDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ReceiptLineDto)
  lines!: ReceiptLineDto[];
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class ListPurchaseOrdersQuery {
  @IsOptional() @IsIn(PO_STATUSES) status?: (typeof PO_STATUSES)[number];
  @IsOptional() @IsUUID() supplierId?: string;
  @IsOptional() @IsUUID() warehouseId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number = 20;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000) offset: number = 0;
}
