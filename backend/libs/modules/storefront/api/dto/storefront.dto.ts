import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import { GENDERS, Gender, MAX_PAGE_SIZE, normalizeSearch, parseList, STOREFRONT_SORTS, StorefrontSort } from '../../../catalog';

const MONEY = /^\d{1,8}(\.\d{1,2})?$/;
/** Ruta de categoría: segmentos en minúsculas, números y guiones ('mujer/vestidos'). */
const CATEGORY_PATH = /^[a-z0-9-]+(\/[a-z0-9-]+){0,5}$/;
const SLUG = /^[a-z0-9-]{1,120}$/;

const toList = ({ value }: { value: unknown }) => parseList(value as string | string[] | undefined);

/**
 * Listado del catálogo. Filtros de varios valores: 'talla=S,M' o 'talla=S&talla=M'. Los nombres
 * están en inglés como el resto de la API; el storefront arma sus propias URLs en español.
 */
export class ListProductsQuery {
  @IsOptional() @Matches(CATEGORY_PATH) category?: string;
  @IsOptional() @Matches(SLUG) collection?: string;
  @IsOptional() @Transform(toList) @IsIn(GENDERS, { each: true }) gender: Gender[] = [];
  @IsOptional() @Transform(toList) @Matches(SLUG, { each: true }) brand: string[] = [];
  @IsOptional() @Transform(toList) @IsString({ each: true }) @MaxLength(40, { each: true }) color: string[] = [];
  @IsOptional() @Transform(toList) @IsString({ each: true }) @MaxLength(10, { each: true }) size: string[] = [];
  @IsOptional() @Matches(MONEY) minPrice?: string;
  @IsOptional() @Matches(MONEY) maxPrice?: string;
  @IsOptional() @IsIn(['true', 'false']) onSale?: string;
  @IsOptional() @Transform(({ value }) => normalizeSearch(typeof value === 'string' ? value : undefined)) @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsIn(STOREFRONT_SORTS) sort: StorefrontSort = 'relevance';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) page: number = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(MAX_PAGE_SIZE) pageSize: number = 24;
}

export class SuggestQuery {
  @Transform(({ value }) => normalizeSearch(typeof value === 'string' ? value : undefined) ?? '') @IsString() @Length(2, 100) q!: string;
}

export class ProductThumbsQuery {
  /** Hasta 50 ids separados por coma (un carrito tiene a lo sumo unas decenas de líneas). */
  @Transform(toList) @ArrayMinSize(1) @ArrayMaxSize(50) @IsUUID('all', { each: true }) ids!: string[];
}

export class ProductSlugParam {
  @Matches(SLUG) slug!: string;
}
