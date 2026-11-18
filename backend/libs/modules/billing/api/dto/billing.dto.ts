import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { DOCUMENT_STATUSES } from '../../domain/electronic-document';

export class ListDocumentsQuery {
  /** "returned,not_authorized" o status=returned&status=not_authorized. */
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined ? undefined : (Array.isArray(value) ? value : String(value).split(',')).map((s) => String(s).trim()).filter(Boolean),
  )
  @IsArray()
  @ArrayMaxSize(DOCUMENT_STATUSES.length)
  @IsIn(DOCUMENT_STATUSES, { each: true })
  status?: (typeof DOCUMENT_STATUSES)[number][];

  @IsOptional() @IsUUID() orderId?: string;
  @IsOptional() @IsUUID() returnId?: string;
  /** 01 factura, 04 nota de crédito. */
  @IsOptional() @IsIn(['01', '04']) docType?: '01' | '04';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number = 20;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000) offset: number = 0;
}
