import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
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
import {
  MAX_BULK_PRICE_ROWS,
  PRODUCT_STATUSES,
  ProductStatus,
  SIZE_SYSTEMS,
  SizeSystem,
  SLUG_MAX_LENGTH,
  SLUG_RE,
  VARIANT_STATUSES,
  VariantStatus,
} from '../../domain/admin-catalog';
import { Gender, GENDERS } from '../../domain/storefront';

/** Monto "12.50" (también se acepta el número 12.5): máximo 2 decimales, no negativo. */
const MONEY = /^\d{1,10}(\.\d{1,2})?$/;
const MONEY_MSG = (f: string) => ({ message: `${f} debe ser un monto con máximo 2 decimales (p. ej. "19.90")` });
const toMoneyString = ({ value }: { value: unknown }) => (typeof value === 'number' && Number.isFinite(value) ? String(value) : value);
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** null permitido: limpia el campo. */
const nullable = (field: string) => ValidateIf((o) => o[field] !== null);

export class AdminProductsQuery {
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsIn(PRODUCT_STATUSES) status?: ProductStatus;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsUUID() brandId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number = 25;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100_000) offset: number = 0;
}

export class CreateProductDto {
  @Transform(trim) @IsString() @Length(2, 200) name!: string;
  @IsOptional() @IsString() @MaxLength(SLUG_MAX_LENGTH) @Matches(SLUG_RE, { message: 'slug: minúsculas, números y guiones (p. ej. "vestido-floral")' }) slug?: string;
  @IsOptional() @nullable('description') @IsString() @MaxLength(10_000) description?: string | null;
  @IsUUID() categoryId!: string;
  @IsOptional() @nullable('brandId') @IsUUID() brandId?: string | null;
  @IsOptional() @nullable('sizeChartId') @IsUUID() sizeChartId?: string | null;
  @IsIn(GENDERS) gender!: Gender;
  @IsOptional() @nullable('season') @IsString() @MaxLength(60) season?: string | null;
  @IsOptional() @nullable('material') @IsString() @MaxLength(300) material?: string | null;
  @IsOptional() @nullable('careInstructions') @IsString() @MaxLength(2000) careInstructions?: string | null;
  @Transform(toMoneyString) @IsString() @Matches(MONEY, MONEY_MSG('basePrice')) basePrice!: string;
  @IsOptional() @nullable('compareAtPrice') @Transform(toMoneyString) @IsString() @Matches(MONEY, MONEY_MSG('compareAtPrice')) compareAtPrice?: string | null;
  @IsOptional() @nullable('cost') @Transform(toMoneyString) @IsString() @Matches(MONEY, MONEY_MSG('cost')) cost?: string | null;
  @IsOptional() @IsString() @Matches(/^\d{1,4}$/, { message: 'taxCode: código de porcentaje de IVA del SRI (p. ej. "4" = 15 %)' }) taxCode?: string;
  @IsOptional() @IsIn(PRODUCT_STATUSES) status?: ProductStatus;
}

export class UpdateProductDto {
  @IsOptional() @Transform(trim) @IsString() @Length(2, 200) name?: string;
  @IsOptional() @IsString() @MaxLength(SLUG_MAX_LENGTH) @Matches(SLUG_RE, { message: 'slug: minúsculas, números y guiones (p. ej. "vestido-floral")' }) slug?: string;
  @IsOptional() @nullable('description') @IsString() @MaxLength(10_000) description?: string | null;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @nullable('brandId') @IsUUID() brandId?: string | null;
  @IsOptional() @nullable('sizeChartId') @IsUUID() sizeChartId?: string | null;
  @IsOptional() @IsIn(GENDERS) gender?: Gender;
  @IsOptional() @nullable('season') @IsString() @MaxLength(60) season?: string | null;
  @IsOptional() @nullable('material') @IsString() @MaxLength(300) material?: string | null;
  @IsOptional() @nullable('careInstructions') @IsString() @MaxLength(2000) careInstructions?: string | null;
  @IsOptional() @Transform(toMoneyString) @IsString() @Matches(MONEY, MONEY_MSG('basePrice')) basePrice?: string;
  @IsOptional() @nullable('compareAtPrice') @Transform(toMoneyString) @IsString() @Matches(MONEY, MONEY_MSG('compareAtPrice')) compareAtPrice?: string | null;
  @IsOptional() @nullable('cost') @Transform(toMoneyString) @IsString() @Matches(MONEY, MONEY_MSG('cost')) cost?: string | null;
  @IsOptional() @IsString() @Matches(/^\d{1,4}$/, { message: 'taxCode: código de porcentaje de IVA del SRI (p. ej. "4" = 15 %)' }) taxCode?: string;
  @IsOptional() @IsIn(PRODUCT_STATUSES) status?: ProductStatus;
  /** updatedAt que el backoffice leyó: si el producto cambió desde entonces, 409 STALE_PRODUCT. */
  @IsISO8601({ strict: true }) expectedUpdatedAt!: string;
}

const SKU = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const BARCODE = /^[A-Za-z0-9-]{4,64}$/;

export class CreateVariantDto {
  @Transform(trim) @IsString() @Matches(SKU, { message: 'sku: letras, números, ".", "_", "/" o "-" (máx. 64)' }) sku!: string;
  @IsOptional() @nullable('barcode') @Transform(trim) @IsString() @Matches(BARCODE, { message: 'barcode: de 4 a 64 letras, números o "-"' }) barcode?: string | null;
  @IsOptional() @nullable('colorId') @IsUUID() colorId?: string | null;
  @IsOptional() @nullable('sizeId') @IsUUID() sizeId?: string | null;
  /** null = usa el precio del producto. */
  @IsOptional() @nullable('price') @Transform(toMoneyString) @IsString() @Matches(MONEY, MONEY_MSG('price')) price?: string | null;
  @IsOptional() @nullable('compareAtPrice') @Transform(toMoneyString) @IsString() @Matches(MONEY, MONEY_MSG('compareAtPrice')) compareAtPrice?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(100_000) weightG?: number;
  @IsOptional() @IsIn(VARIANT_STATUSES) status?: VariantStatus;
}

export class UpdateVariantDto {
  @IsOptional() @Transform(trim) @IsString() @Matches(SKU, { message: 'sku: letras, números, ".", "_", "/" o "-" (máx. 64)' }) sku?: string;
  @IsOptional() @nullable('barcode') @Transform(trim) @IsString() @Matches(BARCODE, { message: 'barcode: de 4 a 64 letras, números o "-"' }) barcode?: string | null;
  @IsOptional() @nullable('colorId') @IsUUID() colorId?: string | null;
  @IsOptional() @nullable('sizeId') @IsUUID() sizeId?: string | null;
  @IsOptional() @nullable('price') @Transform(toMoneyString) @IsString() @Matches(MONEY, MONEY_MSG('price')) price?: string | null;
  @IsOptional() @nullable('compareAtPrice') @Transform(toMoneyString) @IsString() @Matches(MONEY, MONEY_MSG('compareAtPrice')) compareAtPrice?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(100_000) weightG?: number;
  @IsOptional() @IsIn(VARIANT_STATUSES) status?: VariantStatus;
}

export class ProductPriceRowDto {
  @IsUUID() id!: string;
  @IsOptional() @Transform(toMoneyString) @IsString() @Matches(MONEY, MONEY_MSG('basePrice')) basePrice?: string;
  @IsOptional() @nullable('compareAtPrice') @Transform(toMoneyString) @IsString() @Matches(MONEY, MONEY_MSG('compareAtPrice')) compareAtPrice?: string | null;
}

export class VariantPriceRowDto {
  @IsUUID() id!: string;
  @IsOptional() @nullable('price') @Transform(toMoneyString) @IsString() @Matches(MONEY, MONEY_MSG('price')) price?: string | null;
  @IsOptional() @nullable('compareAtPrice') @Transform(toMoneyString) @IsString() @Matches(MONEY, MONEY_MSG('compareAtPrice')) compareAtPrice?: string | null;
}

export class BulkPricesDto {
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_BULK_PRICE_ROWS) @ValidateNested({ each: true }) @Type(() => ProductPriceRowDto) products?: ProductPriceRowDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_BULK_PRICE_ROWS) @ValidateNested({ each: true }) @Type(() => VariantPriceRowDto) variants?: VariantPriceRowDto[];
}

export class CreateBrandDto {
  @Transform(trim) @IsString() @Length(1, 100) name!: string;
}

export class CreateCategoryDto {
  @Transform(trim) @IsString() @Length(1, 100) name!: string;
  @IsOptional() @nullable('parentId') @IsUUID() parentId?: string | null;
}

export class CreateColorDto {
  @Transform(trim) @IsString() @Length(1, 60) name!: string;
  @IsOptional() @nullable('hex') @IsString() @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'hex: color "#RRGGBB"' }) hex?: string | null;
}

export class CreateSizeDto {
  @Transform(trim) @IsString() @Length(1, 20) code!: string;
  @IsIn(SIZE_SYSTEMS) sizeSystem!: SizeSystem;
  @IsOptional() @IsInt() @Min(0) @Max(10_000) sortOrder?: number;
}

/** Tope de ?ids= por consulta (las pantallas de Bodega piden por lotes). */
export const MAX_LOOKUP_IDS = 100;

/** "a,b" o ids=a&ids=b → ['a', 'b'] (sin vacíos). */
const toIdList = ({ value }: { value: unknown }) =>
  value === undefined
    ? undefined
    : (Array.isArray(value) ? value : String(value).split(','))
        .map((s) => String(s).trim())
        .filter(Boolean);

export class VariantLookupQuery {
  @IsOptional() @Transform(trim) @IsString() @Length(1, 64) barcode?: string;
  /** Variantes por id (nombre/SKU de lo que muestra Inventario). Máximo 100. */
  @IsOptional() @Transform(toIdList) @IsArray() @ArrayMaxSize(MAX_LOOKUP_IDS) @IsUUID('all', { each: true }) ids?: string[];
  @IsOptional() @Transform(trim) @IsString() @Length(2, 100) q?: string;
}

/** Campos de texto del multipart de una foto. */
export class UploadMediaDto {
  @IsOptional() @IsUUID() colorId?: string;
  @IsOptional() @IsString() @MaxLength(200) altText?: string;
}

/** Edición de una foto existente: color (null = todas), texto alternativo (null lo quita) y orden. */
export class UpdateMediaDto {
  @IsOptional() @nullable('colorId') @IsUUID() colorId?: string | null;
  @IsOptional() @nullable('altText') @IsString() @MaxLength(200) altText?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(10_000) sortOrder?: number;
}
