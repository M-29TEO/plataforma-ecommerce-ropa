import { Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig, createObjectStorage } from '../../shared-kernel';
import { InventoryModule } from '../inventory';
import { IamModule } from '../iam';
import { OrdersModule } from '../orders';
import { MyShipmentsController, RiderAppController, RidersController, SettlementsController } from './api/ratings-settlements.controller';
import { LiveRidersController, RiderPresenceController, ShipmentsListController } from './api/live-ops.controller';
import { DeliveryProofsController, DispatchController, MyOrderShipmentsController, PublicTrackingController, RiderTrackingController } from './api/tracking.controller';
import { RiderWorkController } from './api/rider-app.controller';
import { DispatchService } from './application/dispatch.service';
import { DeliveryProofStorage, DispatchRepository, RiderAppRepository, RiderOfferNotifier } from './application/rider-app-ports';
import { RiderAppService } from './application/rider-app.service';
import { PgDispatchRepository } from './infrastructure/pg-dispatch.repository';
import { PgRiderAppRepository } from './infrastructure/pg-rider-app.repository';
import { InMemoryRiderOfferNotifier, NtfyRiderOfferNotifier } from './infrastructure/notifier/ntfy-rider-offer.notifier';
import { DispatchOffersJob } from './infrastructure/jobs/dispatch-offers.job';
import { QuotesController, ZoneSlotsController, ZonesController } from './api/zones.controller';
import { CourierQuoteAggregator } from './application/courier-quote.aggregator';
import { DeliveryQuoteService } from './application/delivery-quote.service';
import { HandoffRepository } from './application/handoff-ports';
import { HandoffService } from './application/handoff.service';
import { LogisticsApi } from './application/logistics.api';
import {
  CourierAdapters,
  CourierPort,
  CourierRepository,
  MapsPort,
  RatingRepository,
  RiderRepository,
  SettlementRepository,
  ShipmentRepository,
  SlotRepository,
  ZoneRepository,
} from './application/ports';
import { RatingService } from './application/rating.service';
import { ReverseLogisticsService } from './application/reverse-logistics.service';
import { RiderDistanceService } from './application/rider-distance.service';
import { SettlementService } from './application/settlement.service';
import { SlotService } from './application/slot.service';
import { TrackingRepository } from './application/tracking-ports';
import { TrackingTokenResolver } from './application/tracking-token.resolver';
import { TrackingService } from './application/tracking.service';
import { ZoneService } from './application/zone.service';
import { LiveOpsRepository } from './application/live-ops-ports';
import { LiveOpsService } from './application/live-ops.service';
import { LogisticsConsumer } from './infrastructure/consumers/logistics.consumer';
import { CourierSimuladoAdapter } from './infrastructure/couriers/courier-simulado.adapter';
import { GenerateDeliverySlotsJob } from './infrastructure/jobs/generate-delivery-slots.job';
import { RiderLocationPartitionsJob } from './infrastructure/jobs/rider-location-partitions.job';
import { WeeklyRiderSettlementsJob } from './infrastructure/jobs/weekly-rider-settlements.job';
import { NoMapsAdapter, OsrmMapsAdapter } from './infrastructure/maps/osrm-maps.adapter';
import { LogisticsPersonalDataContributor } from './infrastructure/personal-data.contributor';
import { PgCourierRepository } from './infrastructure/pg-courier.repository';
import { PgRatingRepository } from './infrastructure/pg-rating.repository';
import { PgRiderRepository } from './infrastructure/pg-rider.repository';
import { PgSettlementRepository } from './infrastructure/pg-settlement.repository';
import { PgShipmentRepository } from './infrastructure/pg-shipment.repository';
import { PgSlotRepository } from './infrastructure/pg-slot.repository';
import { PgTrackingRepository } from './infrastructure/pg-tracking.repository';
import { PgHandoffRepository } from './infrastructure/pg-handoff.repository';
import { PgZoneRepository } from './infrastructure/pg-zone.repository';
import { PgLiveOpsRepository } from './infrastructure/pg-live-ops.repository';

/** Registro de adaptadores de courier habilitados por COURIER_ADAPTERS. */
class ConfiguredCourierAdapters extends CourierAdapters {
  private readonly byName: Map<string, CourierPort>;

  constructor(ports: CourierPort[]) {
    super();
    this.byName = new Map(ports.map((p) => [p.adapter, p]));
  }

  get(adapter: string): CourierPort | null {
    return this.byName.get(adapter) ?? null;
  }
}

function courierAdapters(c: AppConfig): CourierAdapters {
  const available: Record<string, () => CourierPort> = {
    simulator: () => new CourierSimuladoAdapter(c.logistics.courierSimulatorUrl, c.logistics.courierSimulatorApiKey),
  };
  const unknown = c.logistics.courierAdapters.filter((a) => !available[a]);
  if (unknown.length > 0) throw new Error(`COURIER_ADAPTERS desconocidos: ${unknown.join(', ')} (disponibles: simulator)`);
  return new ConfiguredCourierAdapters(c.logistics.courierAdapters.map((a) => available[a]()));
}

/**
 * Módulo Logística, parte de cotización (schema logistics: coverage_zones, delivery_slot_templates,
 * delivery_slots, couriers, courier_services, courier_rate_cards, courier_quotes y shipments en
 * estado 'pending'), más calificaciones (ratings), liquidaciones de motorizados (riders.cod_balance,
 * rider_settlements, rider_settlement_items) y logística inversa de devoluciones y cambios (shipments con
 * direction 'return' / 'exchange'). Requiere ConfigModule, DatabaseModule y OutboxModule del shared kernel.
 *
 * App del motorizado: turnos (rider_shifts), despacho automático (dispatch_offers) y entrega con
 * prueba (delivery_proofs: foto, firma y código).
 *
 * Adaptadores: MapsPort → OSRM (o línea recta si OSRM_URL está vacío), CourierPort → courier
 * simulado (COURIER_ADAPTERS=simulator), RiderOfferNotifier → ntfy o memoria (RIDER_OFFER_TRANSPORT)
 * y DeliveryProofStorage → SeaweedFS o memoria (DELIVERY_PROOF_STORAGE).
 */
@Module({
  imports: [InventoryModule, OrdersModule, IamModule],
  controllers: [
    ZonesController,
    ZoneSlotsController,
    QuotesController,
    MyShipmentsController,
    RiderAppController,
    RidersController,
    SettlementsController,
    PublicTrackingController,
    MyOrderShipmentsController,
    DispatchController,
    RiderTrackingController,
    LiveRidersController,
    ShipmentsListController,
    RiderPresenceController,
    RiderWorkController,
    DeliveryProofsController,
  ],
  providers: [
    { provide: ZoneRepository, useClass: PgZoneRepository },
    { provide: SlotRepository, useClass: PgSlotRepository },
    { provide: CourierRepository, useClass: PgCourierRepository },
    { provide: ShipmentRepository, useClass: PgShipmentRepository },
    { provide: RiderRepository, useClass: PgRiderRepository },
    { provide: RatingRepository, useClass: PgRatingRepository },
    { provide: SettlementRepository, useClass: PgSettlementRepository },
    { provide: TrackingRepository, useClass: PgTrackingRepository },
    { provide: HandoffRepository, useClass: PgHandoffRepository },
    { provide: LiveOpsRepository, useClass: PgLiveOpsRepository },
    { provide: DispatchRepository, useClass: PgDispatchRepository },
    { provide: RiderAppRepository, useClass: PgRiderAppRepository },
    {
      provide: DeliveryProofStorage,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig) => createObjectStorage(c.logistics.proofStorage, c.logistics.seaweedFilerUrl),
    },
    {
      provide: RiderOfferNotifier,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig) =>
        c.logistics.offerTransport === 'memory' ? new InMemoryRiderOfferNotifier() : new NtfyRiderOfferNotifier(c.logistics.ntfyUrl, c.logistics.ntfyToken),
    },
    {
      provide: MapsPort,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig) =>
        c.logistics.osrmUrl ? new OsrmMapsAdapter(c.logistics.osrmUrl, c.logistics.osrmTimeoutMs) : new NoMapsAdapter(),
    },
    { provide: CourierAdapters, inject: [APP_CONFIG], useFactory: courierAdapters },
    ZoneService,
    SlotService,
    RiderDistanceService,
    CourierQuoteAggregator,
    DeliveryQuoteService,
    RatingService,
    SettlementService,
    ReverseLogisticsService,
    TrackingService,
    HandoffService,
    LiveOpsService,
    DispatchService,
    RiderAppService,
    LogisticsApi,
    LogisticsPersonalDataContributor,
  ],
  exports: [LogisticsApi, DeliveryQuoteService, SlotService, SettlementService, DispatchService],
})
export class LogisticsModule {}

/** Consumidores de eventos de Pedidos (proceso worker; en tests, junto con el relay). */
@Module({ imports: [LogisticsModule], providers: [LogisticsConsumer] })
export class LogisticsConsumersModule {}

/** Jobs del proceso worker (franjas cada hora, liquidaciones semanales, particiones y despacho automático). Requiere QueueModule. */
@Module({ imports: [LogisticsModule], providers: [GenerateDeliverySlotsJob, WeeklyRiderSettlementsJob, RiderLocationPartitionsJob, DispatchOffersJob] })
export class LogisticsWorkerModule {}

/**
 * Para el proceso realtime (apps/realtime): solo resuelve tokens de seguimiento. Sin controladores
 * ni dependencias de otros módulos. Requiere ConfigModule y DatabaseModule.
 */
@Module({
  providers: [{ provide: TrackingRepository, useClass: PgTrackingRepository }, TrackingTokenResolver],
  exports: [TrackingTokenResolver],
})
export class LogisticsRealtimeModule {}
