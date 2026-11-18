import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog';
import { IamModule } from '../iam';
import { InventoryModule } from '../inventory';
import { OrdersModule } from '../orders';
import { PromotionsModule } from '../promotions';
import { CrmAdminController, MyAddressesController, MyLoyaltyController, MyReferralController, MyWishlistController } from './api/crm.controller';
import { AddressService } from './application/address.service';
import { CrmApi } from './application/crm.api';
import { LoyaltyService } from './application/loyalty.service';
import { AddressRepository, GeocoderPort, LoyaltyRepository, ReferralRepository, WishlistRepository } from './application/ports';
import { ReferralService } from './application/referral.service';
import { WishlistService } from './application/wishlist.service';
import { CrmConsumer } from './infrastructure/consumers/crm.consumer';
import { NominatimGeocoder } from './infrastructure/geocoding/nominatim.geocoder';
import { CrmMaintenanceJob } from './infrastructure/jobs/crm-maintenance.job';
import { CrmPersonalDataContributor } from './infrastructure/personal-data.contributor';
import { PgAddressRepository } from './infrastructure/pg-address.repository';
import { PgLoyaltyRepository } from './infrastructure/pg-loyalty.repository';
import { PgReferralRepository } from './infrastructure/pg-referral.repository';
import { PgWishlistRepository } from './infrastructure/pg-wishlist.repository';

/**
 * Módulo CRM y Fidelización (schema crm): direcciones con geocodificación (Nominatim) o pin,
 * wishlist con alertas, puntos con niveles y referidos. Nadie importa este módulo salvo Checkout
 * (direcciones guardadas): los efectos de Pedidos llegan por eventos.
 */
@Module({
  imports: [OrdersModule, CatalogModule, InventoryModule, PromotionsModule, IamModule],
  controllers: [MyAddressesController, MyWishlistController, MyLoyaltyController, MyReferralController, CrmAdminController],
  providers: [
    { provide: AddressRepository, useClass: PgAddressRepository },
    { provide: WishlistRepository, useClass: PgWishlistRepository },
    { provide: LoyaltyRepository, useClass: PgLoyaltyRepository },
    { provide: ReferralRepository, useClass: PgReferralRepository },
    { provide: GeocoderPort, useClass: NominatimGeocoder },
    AddressService,
    WishlistService,
    LoyaltyService,
    ReferralService,
    CrmApi,
    CrmPersonalDataContributor,
  ],
  // Los servicios se exportan solo para los módulos de consumidores y jobs (index.ts no los expone).
  exports: [CrmApi, LoyaltyService, ReferralService, WishlistService],
})
export class CrmModule {}

/** Consumidores de eventos de Pedidos (proceso worker; en tests, junto con el relay). */
@Module({ imports: [CrmModule], providers: [CrmConsumer] })
export class CrmConsumersModule {}

/** Jobs del proceso worker (puntos, referidos y alertas de wishlist). Requiere QueueModule. */
@Module({ imports: [CrmModule], providers: [CrmMaintenanceJob] })
export class CrmWorkerModule {}
