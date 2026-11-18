import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { Audited, Auth, AuthUser, CurrentUser, MatchesPipe, missingPermission, Public, RequirePermission, sendStoredFile } from '../../../shared-kernel';
import { CatalogActor, CatalogAdminService, MEDIA_FILE_RE, MediaFile, PRODUCT_MEDIA_MAX_BYTES } from '../application/catalog-admin.service';

/** Nombre del archivo de una foto (<uuid>.jpg|png|webp): sin barras ni '..', no sale del prefijo del producto. */
const MEDIA_FILE = new MatchesPipe(MEDIA_FILE_RE, 'archivo de foto');
import {
  AdminProductsQuery,
  BulkPricesDto,
  CreateBrandDto,
  CreateCategoryDto,
  CreateColorDto,
  CreateProductDto,
  CreateSizeDto,
  CreateVariantDto,
  UpdateProductDto,
  UpdateMediaDto,
  UpdateVariantDto,
  UploadMediaDto,
  VariantLookupQuery,
} from './dto/admin.dto';

const WRITE = 'catalog.product.write';

function actorOf(user: AuthUser, req: Request): CatalogActor {
  return { tenantId: user.tenantId, id: user.id, type: user.type, ip: req.ip ?? null };
}

/**
 * Backoffice: productos, variantes, precios, tablas auxiliares y fotos. Todo con el tenant del JWT
 * y el permiso catalog.product.write (admin, gerente y vendedor). Productos, variantes y precios se
 * auditan con before/after en el servicio; las altas auxiliares y las fotos, con @Audited.
 */
@Controller('catalog/admin')
export class CatalogAdminController {
  constructor(private readonly admin: CatalogAdminService) {}

  @Get('products')
  @RequirePermission(WRITE)
  list(@CurrentUser() user: AuthUser, @Query() q: AdminProductsQuery) {
    return this.admin.listProducts(user.tenantId, q);
  }

  @Get('products/:id')
  @RequirePermission(WRITE)
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.admin.getProduct(user.tenantId, id);
  }

  @Post('products')
  @RequirePermission(WRITE)
  create(@CurrentUser() user: AuthUser, @Req() req: Request, @Body() dto: CreateProductDto) {
    return this.admin.createProduct(actorOf(user, req), dto);
  }

  @Patch('products/:id')
  @RequirePermission(WRITE)
  update(@CurrentUser() user: AuthUser, @Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProductDto) {
    return this.admin.updateProduct(actorOf(user, req), id, dto);
  }

  @Post('products/:id/variants')
  @RequirePermission(WRITE)
  createVariant(@CurrentUser() user: AuthUser, @Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateVariantDto) {
    return this.admin.createVariant(actorOf(user, req), id, dto);
  }

  @Patch('variants/:id')
  @RequirePermission(WRITE)
  updateVariant(@CurrentUser() user: AuthUser, @Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateVariantDto) {
    return this.admin.updateVariant(actorOf(user, req), id, dto);
  }

  /** Precios masivos: todo o nada, máximo 200 filas. */
  @Patch('prices')
  @RequirePermission(WRITE)
  prices(@CurrentUser() user: AuthUser, @Req() req: Request, @Body() dto: BulkPricesDto) {
    return this.admin.bulkPrices(actorOf(user, req), dto);
  }

  @Get('lookups')
  @RequirePermission(WRITE)
  lookups(@CurrentUser() user: AuthUser) {
    return this.admin.lookups(user.tenantId);
  }

  @Post('brands')
  @RequirePermission(WRITE)
  @Audited('catalog.brand.created', { entity: 'brand' })
  brand(@CurrentUser() user: AuthUser, @Req() req: Request, @Body() dto: CreateBrandDto) {
    return this.admin.createBrand(actorOf(user, req), dto.name);
  }

  @Post('categories')
  @RequirePermission(WRITE)
  @Audited('catalog.category.created', { entity: 'category' })
  category(@CurrentUser() user: AuthUser, @Req() req: Request, @Body() dto: CreateCategoryDto) {
    return this.admin.createCategory(actorOf(user, req), dto.name, dto.parentId ?? null);
  }

  @Post('colors')
  @RequirePermission(WRITE)
  @Audited('catalog.color.created', { entity: 'color' })
  color(@CurrentUser() user: AuthUser, @Req() req: Request, @Body() dto: CreateColorDto) {
    return this.admin.createColor(actorOf(user, req), dto.name, dto.hex ?? null);
  }

  @Post('sizes')
  @RequirePermission(WRITE)
  @Audited('catalog.size.created', { entity: 'size' })
  size(@CurrentUser() user: AuthUser, @Req() req: Request, @Body() dto: CreateSizeDto) {
    return this.admin.createSize(actorOf(user, req), dto.code, dto.sizeSystem, dto.sortOrder ?? 0);
  }

  /** multipart: campo "file" (jpg, png o webp ≤ 5 MB) y opcionales colorId, altText. */
  @Post('products/:id/media')
  @RequirePermission(WRITE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: PRODUCT_MEDIA_MAX_BYTES + 1, files: 1 } }))
  @Audited('catalog.media.uploaded', { entity: 'product', body: false })
  upload(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: MediaFile | undefined,
    @Body() dto: UploadMediaDto,
  ) {
    return this.admin.uploadMedia(actorOf(user, req), id, file, { colorId: dto.colorId ?? null, altText: dto.altText ?? null });
  }

  @Delete('media/:id')
  @RequirePermission(WRITE)
  @Audited('catalog.media.deleted', { entity: 'media' })
  deleteMedia(@CurrentUser() user: AuthUser, @Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.admin.deleteMedia(actorOf(user, req), id);
  }

  @Patch('media/:id')
  @RequirePermission(WRITE)
  @Audited('catalog.media.updated', { entity: 'media' })
  updateMedia(@CurrentUser() user: AuthUser, @Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateMediaDto) {
    return this.admin.updateMedia(actorOf(user, req), id, dto);
  }
}

/** Basta CUALQUIERA de estos permisos para buscar variantes (Bodega, Vendedor, Admin, Gerente). */
export const VARIANT_LOOKUP_PERMISSIONS = ['inventory.read', 'catalog.product.write', 'orders.assisted.create', 'inventory.picking'];

@Controller('catalog')
export class CatalogVariantLookupController {
  constructor(private readonly admin: CatalogAdminService) {}

  /**
   * ?barcode= (exacto, 0 o 1 resultado: el escaneo con la cámara), ?ids= (hasta 100 uuids separados por
   * coma: nombres de lo que muestra Inventario) o ?q= (SKU, código o nombre; máx. 20). @RequirePermission exige TODOS los permisos, así que el "cualquiera de" va a mano.
   */
  @Get('variants/lookup')
  @Auth()
  lookup(@CurrentUser() user: AuthUser, @Query() q: VariantLookupQuery) {
    if (user.type !== 'staff' || !VARIANT_LOOKUP_PERMISSIONS.some((p) => user.permissions.includes(p))) {
      throw missingPermission(VARIANT_LOOKUP_PERMISSIONS, user);
    }
    return this.admin.lookupVariants(user.tenantId, q);
  }

  /**
   * Fotos subidas desde el backoffice (públicas, como las de la tienda). Con
   * CATALOG_MEDIA_BASE_URL=/api/v1/catalog/media las URL de product_media apuntan aquí.
   */
  @Get('media/products/:tenantId/:productId/:file')
  @Public()
  async media(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('file', MEDIA_FILE) file: string,
    @Res() res: Response,
  ) {
    sendStoredFile(res, await this.admin.mediaFile(tenantId, productId, file), { cache: 'public, max-age=86400' });
  }
}
