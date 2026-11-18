import { Injectable } from '@nestjs/common';
import { Database, OutboxWriter } from '../../../shared-kernel';
import { OrderNotFoundError, OrdersApi } from '../../orders';
import { AlreadyRatedError, CustomerNotRateableError, RiderNotFoundError, ShipmentNotFoundError } from '../domain/errors';
import { customerRated, riderRated } from '../domain/events';
import { assertRateable, RatingInput, normalizeRating } from '../domain/rating';
import { RateableShipment, RatingRecord, RatingRepository, RiderRepository } from './ports';

export type RatingView = Omit<RatingRecord, 'raterId' | 'rateeId'>;

const view = ({ raterId: _r, rateeId: _e, ...rest }: RatingRecord): RatingView => rest;

/**
 * Calificaciones mutuas de una entrega con motorizado. El dueño del pedido está en Pedidos
 * (schema sales): se consulta por OrdersApi, nunca con un join.
 */
@Injectable()
export class RatingService {
  constructor(
    private readonly db: Database,
    private readonly ratings: RatingRepository,
    private readonly riders: RiderRepository,
    private readonly orders: OrdersApi,
    private readonly outbox: OutboxWriter,
  ) {}

  /** El cliente califica al motorizado. Un envío ajeno responde 404 (no se revela que existe). */
  async rateRider(tenantId: string, customerId: string, shipmentId: string, input: RatingInput, now = new Date()) {
    const rating = normalizeRating('customer', input);
    const shipment = await this.riderShipment(tenantId, shipmentId);
    const orderOwner = await this.orderOwner(tenantId, shipment.orderId);
    if (orderOwner !== customerId) throw new ShipmentNotFoundError(shipmentId);
    assertRateable(shipment, now);

    return this.db.withTransaction(async (tx) => {
      // Bloquear primero: el promedio se recalcula viendo las calificaciones concurrentes ya confirmadas.
      await this.riders.lock(tx, shipment.riderId!);
      const saved = await this.ratings.insert(tx, {
        ...rating,
        shipmentId,
        raterType: 'customer',
        raterId: customerId,
        rateeId: shipment.riderUserId!,
      });
      if (!saved) throw new AlreadyRatedError(shipmentId);
      const rider = await this.riders.recomputeRating(tx, shipment.riderId!);
      await this.outbox.append(tx, [
        riderRated(tenantId, saved.id, {
          shipmentId,
          orderId: shipment.orderId,
          riderId: shipment.riderId!,
          customerId,
          score: saved.score,
          tags: saved.tags,
          ...rider,
        }),
      ]);
      return { rating: view(saved), rider: { id: shipment.riderId!, ...rider } };
    });
  }

  /** El motorizado califica al cliente de una entrega suya. */
  async rateCustomer(tenantId: string, riderUserId: string, shipmentId: string, input: RatingInput, now = new Date()) {
    const rating = normalizeRating('rider', input);
    const rider = await this.riders.findByUser(this.db, tenantId, riderUserId);
    if (!rider) throw new RiderNotFoundError(riderUserId);
    const shipment = await this.riderShipment(tenantId, shipmentId);
    if (shipment.riderId !== rider.id) throw new ShipmentNotFoundError(shipmentId);
    assertRateable(shipment, now);
    const customerId = await this.orderOwner(tenantId, shipment.orderId);
    if (!customerId) throw new CustomerNotRateableError(shipmentId);

    return this.db.withTransaction(async (tx) => {
      const saved = await this.ratings.insert(tx, { ...rating, shipmentId, raterType: 'rider', raterId: rider.userId, rateeId: customerId });
      if (!saved) throw new AlreadyRatedError(shipmentId);
      const summary = await this.ratings.summary(tx, 'rider', customerId);
      await this.outbox.append(tx, [
        customerRated(tenantId, saved.id, {
          shipmentId,
          orderId: shipment.orderId,
          riderId: rider.id,
          customerId,
          score: saved.score,
          tags: saved.tags,
          customerRatingAvg: summary.ratingAvg!,
          customerRatingCount: summary.ratingCount,
        }),
      ]);
      return { rating: view(saved), customer: { id: customerId, ratingAvg: summary.ratingAvg, ratingCount: summary.ratingCount } };
    });
  }

  /** Backoffice: promedio del motorizado y sus últimas calificaciones. */
  async listForRider(tenantId: string, riderId: string, limit: number) {
    const rider = await this.riders.findById(this.db, tenantId, riderId);
    if (!rider) throw new RiderNotFoundError(riderId);
    const ratings = await this.ratings.list(this.db, 'customer', rider.userId, limit);
    return { riderId, ratingAvg: rider.ratingAvg, ratingCount: rider.ratingCount, ratings: ratings.map(view) };
  }

  private async riderShipment(tenantId: string, shipmentId: string): Promise<RateableShipment> {
    const s = await this.ratings.findShipment(this.db, tenantId, shipmentId);
    if (!s || s.carrierType !== 'rider' || !s.riderId) throw new ShipmentNotFoundError(shipmentId);
    return s;
  }

  /** userId del pedido (null si fue de invitado). */
  private async orderOwner(tenantId: string, orderId: string): Promise<string | null> {
    try {
      return (await this.orders.getOrder(tenantId, orderId)).userId;
    } catch (e) {
      if (e instanceof OrderNotFoundError) return null;
      throw e;
    }
  }
}
