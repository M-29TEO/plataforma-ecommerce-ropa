import { Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig, createObjectStorage } from '../../shared-kernel';
import { CatalogModule } from '../catalog';
import { InventoryModule } from '../inventory';
import { LogisticsModule } from '../logistics';
import { OrdersModule } from '../orders';
import { PaymentsModule } from '../payments';
import { PromotionsModule } from '../promotions';
import { CustomerReturnsController, RefundApprovalsController, ReturnsController } from './api/returns.controller';
import { AftersalesService } from './application/aftersales.service';
import { ReturnPhotoStorage, StoreCreditMailer } from './application/ports';
import { InMemoryStoreCreditMailer, SmtpStoreCreditMailer } from './infrastructure/store-credit-mailer';

/**
 * Posventa: orquestador de devoluciones y cambios, sin schema propio (como Checkout). Usa solo las
 * fachadas públicas (index.ts) de Pedidos (devoluciones), Catálogo, Inventario, Logística, Pagos
 * (reembolsos) y Promociones (gift cards). Nadie lo importa, así que puede depender de todos sin
 * ciclos entre módulos.
 *
 * Adaptadores: ReturnPhotoStorage → SeaweedFS o memoria (RETURN_PHOTO_STORAGE) y StoreCreditMailer →
 * SMTP/Mailpit o memoria (MAIL_TRANSPORT).
 */
@Module({
  imports: [OrdersModule, CatalogModule, InventoryModule, LogisticsModule, PaymentsModule, PromotionsModule],
  controllers: [CustomerReturnsController, ReturnsController, RefundApprovalsController],
  providers: [
    {
      provide: ReturnPhotoStorage,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig) => createObjectStorage(c.aftersales.photoStorage, c.aftersales.seaweedFilerUrl),
    },
    {
      provide: StoreCreditMailer,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig) =>
        c.aftersales.mailTransport === 'memory' ? new InMemoryStoreCreditMailer() : new SmtpStoreCreditMailer(c.aftersales.smtpUrl, c.aftersales.mailFrom),
    },
    AftersalesService,
  ],
})
export class AftersalesModule {}
