import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { Audited, Auth, AuthUser, CurrentUser, NotFoundError, RateLimit } from '../../../shared-kernel';
import { IamApi } from '../../iam';
import { addressView, AddressService } from '../application/address.service';
import { LoyaltyService } from '../application/loyalty.service';
import { ReferralService } from '../application/referral.service';
import { WishlistService } from '../application/wishlist.service';
import {
  AddToWishlistDto,
  AdjustPointsDto,
  ApplyReferralDto,
  CreateAddressDto,
  CreateTierDto,
  GeocodePreviewDto,
  PageQuery,
  PinDto,
  RedeemPointsDto,
  UpdateAddressDto,
  UpdateTierDto,
  WishlistPreferencesDto,
} from './dto/crm.dto';

function customerOnly(user: AuthUser): void {
  if (user.type !== 'customer') throw new ForbiddenException('Solo para clientes');
}

/** Libreta de direcciones del cliente: geocodificación con Nominatim o pin manual. */
@Controller('me/addresses')
export class MyAddressesController {
  constructor(private readonly addresses: AddressService) {}

  @Get()
  @Auth()
  list(@CurrentUser() user: AuthUser) {
    customerOnly(user);
    return this.addresses.list(user.tenantId, user.id);
  }

  @Post()
  @Auth()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateAddressDto) {
    customerOnly(user);
    const { pin, isDefault, ...fields } = dto;
    return this.addresses.create(user.tenantId, user.id, { ...fields, pin: pin ?? null, isDefault });
  }

  /** Candidatos para el mapa antes de guardar (no escribe nada). Antes de ':id'. */
  @Post('geocode')
  @HttpCode(200)
  @Auth()
  @RateLimit('lookup') // cada vista previa consulta Nominatim (servicio externo con cuota)
  preview(@CurrentUser() user: AuthUser, @Body() dto: GeocodePreviewDto) {
    customerOnly(user);
    return this.addresses.preview({ ...dto });
  }

  @Get(':id')
  @Auth()
  async get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    customerOnly(user);
    return addressView(await this.addresses.get(user.tenantId, user.id, id));
  }

  @Patch(':id')
  @Auth()
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAddressDto) {
    customerOnly(user);
    const { pin, ...fields } = dto;
    return this.addresses.update(user.tenantId, user.id, id, { ...fields, pin: pin ?? null });
  }

  /** Pin manual: el punto exacto marcado en el mapa. */
  @Put(':id/location')
  @Auth()
  setLocation(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PinDto) {
    customerOnly(user);
    return this.addresses.setLocation(user.tenantId, user.id, id, { lat: dto.lat, lng: dto.lng });
  }

  @Post(':id/default')
  @HttpCode(200)
  @Auth()
  setDefault(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    customerOnly(user);
    return this.addresses.setDefault(user.tenantId, user.id, id);
  }

  @Delete(':id')
  @HttpCode(204)
  @Auth()
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    customerOnly(user);
    await this.addresses.delete(user.tenantId, user.id, id);
  }
}

@Controller('me/wishlist')
export class MyWishlistController {
  constructor(private readonly wishlist: WishlistService) {}

  @Get()
  @Auth()
  list(@CurrentUser() user: AuthUser) {
    customerOnly(user);
    return this.wishlist.list(user.tenantId, user.id);
  }

  @Post()
  @Auth()
  add(@CurrentUser() user: AuthUser, @Body() dto: AddToWishlistDto) {
    customerOnly(user);
    return this.wishlist.add(user.tenantId, user.id, dto);
  }

  @Patch(':productId')
  @Auth()
  preferences(@CurrentUser() user: AuthUser, @Param('productId', ParseUUIDPipe) productId: string, @Body() dto: WishlistPreferencesDto) {
    customerOnly(user);
    return this.wishlist.updatePreferences(user.tenantId, user.id, productId, dto);
  }

  @Delete(':productId')
  @HttpCode(204)
  @Auth()
  async remove(@CurrentUser() user: AuthUser, @Param('productId', ParseUUIDPipe) productId: string) {
    customerOnly(user);
    await this.wishlist.remove(user.tenantId, user.id, productId);
  }
}

@Controller('me/loyalty')
export class MyLoyaltyController {
  constructor(private readonly loyalty: LoyaltyService) {}

  @Get()
  @Auth()
  account(@CurrentUser() user: AuthUser) {
    customerOnly(user);
    return this.loyalty.account(user.tenantId, user.id);
  }

  @Get('transactions')
  @Auth()
  history(@CurrentUser() user: AuthUser, @Query() q: PageQuery) {
    customerOnly(user);
    return this.loyalty.history(user.tenantId, user.id, q.limit, q.offset);
  }

  /** Canje por gift card. El código viene SOLO en esta respuesta. */
  @Post('redemptions')
  @Auth()
  redeem(@CurrentUser() user: AuthUser, @Body() dto: RedeemPointsDto) {
    customerOnly(user);
    return this.loyalty.redeem(user.tenantId, user.id, dto.points);
  }
}

@Controller('me/referral')
export class MyReferralController {
  constructor(private readonly referrals: ReferralService) {}

  @Get()
  @Auth()
  summary(@CurrentUser() user: AuthUser) {
    customerOnly(user);
    return this.referrals.summary(user.tenantId, user.id);
  }

  @Post('apply')
  @HttpCode(200)
  @Auth()
  @RateLimit('lookup') // adivinar códigos de referido ajenos
  apply(@CurrentUser() user: AuthUser, @Body() dto: ApplyReferralDto) {
    customerOnly(user);
    return this.referrals.apply(user.tenantId, user.id, dto.code);
  }
}

class CustomerNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('CUSTOMER_NOT_FOUND', 'El cliente no existe', { id });
  }
}

/** Backoffice: niveles del programa y la ficha CRM de un cliente. */
@Controller('crm')
export class CrmAdminController {
  constructor(
    private readonly addresses: AddressService,
    private readonly wishlist: WishlistService,
    private readonly loyalty: LoyaltyService,
    private readonly iam: IamApi,
  ) {}

  @Get('loyalty/tiers')
  @Auth('crm.read')
  tiers(@CurrentUser() user: AuthUser) {
    return this.loyalty.listTiers(user.tenantId);
  }

  @Post('loyalty/tiers')
  @Auth('crm.tiers.write')
  @Audited('crm.tier.create', { entity: 'loyalty_tier' })
  createTier(@CurrentUser() user: AuthUser, @Body() dto: CreateTierDto) {
    return this.loyalty.createTier(user.tenantId, dto);
  }

  @Patch('loyalty/tiers/:id')
  @Auth('crm.tiers.write')
  @Audited('crm.tier.update', { entity: 'loyalty_tier' })
  updateTier(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTierDto) {
    return this.loyalty.updateTier(user.tenantId, id, dto);
  }

  @Delete('loyalty/tiers/:id')
  @HttpCode(204)
  @Auth('crm.tiers.write')
  @Audited('crm.tier.delete', { entity: 'loyalty_tier' })
  async deleteTier(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.loyalty.deleteTier(user.tenantId, id);
  }

  @Get('customers/:userId/loyalty')
  @Auth('crm.read')
  @Audited('crm.customer.view', { entity: 'customer', idParam: 'userId' })
  async account(@CurrentUser() user: AuthUser, @Param('userId', ParseUUIDPipe) userId: string) {
    await this.customer(user.tenantId, userId);
    return this.loyalty.account(user.tenantId, userId);
  }

  @Get('customers/:userId/loyalty/transactions')
  @Auth('crm.read')
  @Audited('crm.customer.view', { entity: 'customer', idParam: 'userId' })
  async history(@CurrentUser() user: AuthUser, @Param('userId', ParseUUIDPipe) userId: string, @Query() q: PageQuery) {
    await this.customer(user.tenantId, userId);
    return this.loyalty.history(user.tenantId, userId, q.limit, q.offset);
  }

  @Post('customers/:userId/loyalty/adjustments')
  @Auth('crm.loyalty.adjust')
  @Audited('crm.points.adjust', { entity: 'customer', idParam: 'userId' })
  async adjust(@CurrentUser() user: AuthUser, @Param('userId', ParseUUIDPipe) userId: string, @Body() dto: AdjustPointsDto) {
    await this.customer(user.tenantId, userId);
    return this.loyalty.adjust(user.tenantId, userId, dto.points, `${dto.reason.trim()} (por ${user.id})`);
  }

  @Get('customers/:userId/addresses')
  @Auth('crm.read')
  @Audited('crm.customer.view', { entity: 'customer', idParam: 'userId' })
  async addressesOf(@CurrentUser() user: AuthUser, @Param('userId', ParseUUIDPipe) userId: string) {
    await this.customer(user.tenantId, userId);
    return this.addresses.list(user.tenantId, userId);
  }

  @Get('customers/:userId/wishlist')
  @Auth('crm.read')
  @Audited('crm.customer.view', { entity: 'customer', idParam: 'userId' })
  async wishlistOf(@CurrentUser() user: AuthUser, @Param('userId', ParseUUIDPipe) userId: string) {
    await this.customer(user.tenantId, userId);
    return this.wishlist.list(user.tenantId, userId);
  }

  /** Un usuario de otro tenant, de staff o anonimizado se reporta como inexistente. */
  private async customer(tenantId: string, userId: string): Promise<void> {
    const contact = await this.iam.getContact(tenantId, userId);
    if (!contact || contact.userType !== 'customer') throw new CustomerNotFoundError(userId);
  }
}
