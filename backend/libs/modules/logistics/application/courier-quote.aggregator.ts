import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig, Database, fromCents, toCents } from '../../../shared-kernel';
import { priceFromRateCards, RateCard } from '../domain/rate-card';
import { chargeableWeightKg } from '../domain/rider-pricing';
import { localDate } from '../domain/slot';
import { CourierAdapters, CourierApiQuote, CourierRepository, CourierServiceInfo, NewCourierQuote, Place } from './ports';

export interface CourierQuoteInput {
  tenantId: string;
  /** province null: el origen no se pudo ubicar (solo se cotiza con el tarifario). */
  origin: { city: string; province: string | null };
  destination: Place;
  weightG: number;
  volumeCm3: number;
  now: Date;
}

export interface CourierOption {
  courierQuoteId: string;
  quoteGroupId: string;
  courierServiceId: string;
  courier: { code: string; name: string };
  service: { code: string; name: string };
  price: string;
  etaHours: number | null;
  /** 'api': respondió el courier; 'rate_card': no respondió a tiempo y se usó el tarifario. */
  source: 'api' | 'rate_card';
}

/** Resultado de un courier: sus cotizaciones o el motivo por el que no se pudo consultar. */
type ApiResult = { ok: true; quotes: CourierApiQuote[] } | { ok: false; error: string };

/**
 * Corre fn con un AbortSignal y un plazo: aborta la petición y, si el adaptador ignora la señal,
 * igual rechaza a los `ms` milisegundos (el checkout nunca espera más que eso).
 */
export function withDeadline<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`sin respuesta en ${ms} ms`));
    }, ms);
  });
  return Promise.race([fn(controller.signal), deadline]).finally(() => clearTimeout(timer));
}

/**
 * CourierQuoteAggregator: cotiza con todos los couriers activos del tenant EN PARALELO, cada uno
 * con COURIER_QUOTE_TIMEOUT_MS (3 s). Si un courier falla o no responde a tiempo, sus servicios
 * se cotizan con courier_rate_cards (tarifario negociado). Si respondió pero no incluyó un
 * servicio, ese servicio no cubre el destino y no se ofrece.
 *
 * Todas las opciones se guardan en courier_quotes con el mismo quote_group_id (auditoría: qué se
 * ofreció, de dónde salió cada precio y cuál eligió el cliente).
 */
@Injectable()
export class CourierQuoteAggregator {
  private readonly logger = new Logger(CourierQuoteAggregator.name);

  constructor(
    private readonly db: Database,
    private readonly couriers: CourierRepository,
    private readonly adapters: CourierAdapters,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async quote(input: CourierQuoteInput): Promise<CourierOption[]> {
    const kg = chargeableWeightKg(input.weightG, input.volumeCm3);
    const services = (await this.couriers.listActiveServices(this.db, input.tenantId)).filter(
      (s) => s.maxWeightKg === null || kg <= s.maxWeightKg,
    );
    if (services.length === 0) return [];

    const byCourier = new Map<string, CourierServiceInfo[]>();
    for (const s of services) byCourier.set(s.courierId, [...(byCourier.get(s.courierId) ?? []), s]);

    const results = await Promise.all(
      [...byCourier.values()].map(async (list) => ({ list, api: await this.askCourier(list[0], input, kg) })),
    );

    let rateCards: RateCard[] | null = null;
    const pending: { service: CourierServiceInfo; quote: Omit<NewCourierQuote, 'quoteGroupId' | 'validUntil'> }[] = [];
    for (const { list, api } of results) {
      if (api.ok) {
        for (const service of list) {
          const q = api.quotes.find((x) => x.serviceCode === service.serviceCode);
          if (!q) continue;
          pending.push({
            service,
            quote: { courierServiceId: service.serviceId, price: fromCents(toCents(q.price)), etaHours: q.etaHours, source: 'api', rawResponse: q.raw },
          });
        }
        continue;
      }
      rateCards ??= await this.couriers.listRateCards(this.db, services.map((s) => s.serviceId));
      for (const service of list) {
        const price = priceFromRateCards(
          rateCards.filter((c) => c.courierServiceId === service.serviceId),
          {
            originCity: input.origin.city,
            destProvince: input.destination.province,
            destCity: input.destination.city,
            kg,
            date: localDate(input.now),
          },
        );
        if (!price) continue;
        pending.push({
          service,
          quote: {
            courierServiceId: service.serviceId,
            price: fromCents(price.priceCents),
            etaHours: service.slaHours,
            source: 'rate_card',
            rawResponse: { rateCardId: price.rateCardId, chargeableKg: kg, apiError: api.error },
          },
        });
      }
    }
    if (pending.length === 0) return [];

    const quoteGroupId = randomUUID();
    const validUntil = new Date(input.now.getTime() + this.config.logistics.quoteTtlMinutes * 60_000);
    const ids = await this.couriers.insertQuotes(
      this.db,
      pending.map((p) => ({ ...p.quote, quoteGroupId, validUntil })),
    );
    return pending
      .map(({ service, quote }, i) => ({
        courierQuoteId: ids[i],
        quoteGroupId,
        courierServiceId: service.serviceId,
        courier: { code: service.courierCode, name: service.courierName },
        service: { code: service.serviceCode, name: service.serviceName },
        price: quote.price,
        etaHours: quote.etaHours,
        source: quote.source,
      }))
      .sort((a, b) => toCents(a.price) - toCents(b.price) || (a.etaHours ?? 999) - (b.etaHours ?? 999));
  }

  private async askCourier(courier: CourierServiceInfo, input: CourierQuoteInput, kg: number): Promise<ApiResult> {
    const port = this.adapters.get(courier.adapter);
    if (!port) return { ok: false, error: `adaptador ${courier.adapter} no habilitado` };
    if (!input.origin.province) return { ok: false, error: 'provincia de origen desconocida' };
    const timeout = this.config.logistics.courierQuoteTimeoutMs;
    const started = Date.now();
    try {
      const quotes = await withDeadline(
        (signal) =>
          port.quote(
            {
              origin: { city: input.origin.city, province: input.origin.province! },
              destination: input.destination,
              weightKg: kg,
              volumeCm3: input.volumeCm3,
            },
            signal,
          ),
        timeout,
      );
      return { ok: true, quotes };
    } catch (error) {
      const message = (error as Error).message;
      this.logger.warn(`Courier ${courier.courierCode} sin cotización tras ${Date.now() - started} ms (${message}); se usa el tarifario`);
      return { ok: false, error: message };
    }
  }
}
