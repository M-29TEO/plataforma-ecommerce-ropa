import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsUUID, Max, Min, ValidateNested } from 'class-validator';
import { PICK_STATES, PickState } from '../../domain/picking';

export class PickingQueueQuery {
  /** Bodega o tienda (sales.orders.source_warehouse_id). Sin ella, todas las del tenant. */
  @IsOptional() @IsUUID() warehouseId?: string;
  /** to_pick: listos para preparar; picking: en preparación y aún sin entregar a logística. */
  @IsOptional() @IsIn(PICK_STATES) state: PickState = 'to_pick';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number = 50;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000) offset: number = 0;
}

export class StartPickingDto {
  /** Versión del pedido que leyó el operador (concurrencia optimista). */
  @IsInt() @Min(0) @Max(2_147_483_647) version!: number;
}

export class PickedItemDto {
  @IsUUID() orderItemId!: string;
  @IsInt() @Min(0) @Max(10_000) pickedQuantity!: number;
}

export class CompletePickingDto {
  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => PickedItemDto)
  items!: PickedItemDto[];
}
