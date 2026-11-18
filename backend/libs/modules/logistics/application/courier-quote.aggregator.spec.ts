import { AppConfig, Database } from '../../../shared-kernel';
import { RateCard } from '../domain/rate-card';
import { CourierQuoteAggregator, withDeadline } from './courier-quote.aggregator';
import { CourierAdapters, CourierApiQuote, CourierPort, CourierRepository, CourierServiceInfo, NewCourierQuote } from './ports';

const service = (courierId: string, code: string, adapter = 'simulator', maxWeightKg: number | null = 30): CourierServiceInfo => ({
  courierId,
  courierCode: courierId,
  courierName: `Courier ${courierId}`,
  adapter,
  supportsCod: true,
  serviceId: `${courierId}-${code}`,
  serviceCode: code,
  serviceName: code,
  maxWeightKg,
  slaHours: code === 'EXPRESS' ? 24 : 48,
});

const rateCard = (serviceId: string, price: string): RateCard => ({
  id: `rc-${serviceId}`,
  courierServiceId: serviceId,
  originCity: 'Quito',
  destProvince: 'Guayas',
  destCity: null,
  weightFromKg: 0,
  weightToKg: 5,
  price,
  extraKgPrice: '1.00',
  validFrom: '2026-01-01',
  validTo: null,
});

class FakeCouriers extends CourierRepository {
  saved: NewCourierQuote[] = [];
  constructor(
    private readonly services: CourierServiceInfo[],
    private readonly cards: RateCard[],
  ) {
    super();
  }
  listActiveServices = async () => this.services;
  listRateCards = async () => this.cards;
  insertQuotes = async (_q: unknown, quotes: NewCourierQuote[]) => {
    this.saved.push(...quotes);
    return quotes.map((_, i) => `q${i}`);
  };
  findQuote = async () => null;
  markSelected = async () => true;
}

class FakePort extends CourierPort {
  calls = 0;
  constructor(
    readonly adapter: string,
    private readonly behavior: (signal: AbortSignal) => Promise<CourierApiQuote[]>,
  ) {
    super();
  }
  quote(_req: unknown, signal: AbortSignal) {
    this.calls++;
    return this.behavior(signal);
  }
  createShipment(): never {
    throw new Error('no usado');
  }
  getLabel(): never {
    throw new Error('no usado');
  }
}

const adapters = (...ports: CourierPort[]): CourierAdapters => ({ get: (a: string) => ports.find((p) => p.adapter === a) ?? null });
const config = { logistics: { courierQuoteTimeoutMs: 80, quoteTtlMinutes: 15 } } as AppConfig;
const input = {
  tenantId: 't1',
  origin: { city: 'Quito', province: 'Pichincha' },
  destination: { city: 'Guayaquil', province: 'Guayas' },
  weightG: 1200,
  volumeCm3: 0,
  now: new Date('2026-09-29T15:00:00Z'),
};
const apiQuote = (serviceCode: string, price: string): CourierApiQuote => ({ serviceCode, price, etaHours: 24, raw: { serviceCode } });

describe('CourierQuoteAggregator', () => {
  it('usa la API cuando responde a tiempo y ordena por precio', async () => {
    const repo = new FakeCouriers([service('sim', 'ESTANDAR'), service('sim', 'EXPRESS')], []);
    const port = new FakePort('simulator', async () => [apiQuote('EXPRESS', '8.84'), apiQuote('ESTANDAR', '6.24')]);
    const options = await new CourierQuoteAggregator({} as Database, repo, adapters(port), config).quote(input);
    expect(options.map((o) => [o.service.code, o.price, o.source])).toEqual([
      ['ESTANDAR', '6.24', 'api'],
      ['EXPRESS', '8.84', 'api'],
    ]);
    expect(port.calls).toBe(1); // una llamada por courier, no por servicio
    expect(new Set(repo.saved.map((s) => s.quoteGroupId)).size).toBe(1);
    expect(repo.saved[0].validUntil.toISOString()).toBe('2026-09-29T15:15:00.000Z');
  });

  it('timeout: aborta la llamada y cotiza con courier_rate_cards', async () => {
    let aborted = false;
    const slow = new FakePort(
      'simulator',
      (signal) =>
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve([apiQuote('ESTANDAR', '1.00')]), 1_000);
          signal.addEventListener('abort', () => {
            aborted = true;
            clearTimeout(timer);
          });
        }),
    );
    const repo = new FakeCouriers([service('sim', 'ESTANDAR')], [rateCard('sim-ESTANDAR', '6.00')]);
    const started = Date.now();
    const options = await new CourierQuoteAggregator({} as Database, repo, adapters(slow), config).quote(input);
    expect(Date.now() - started).toBeLessThan(500);
    expect(aborted).toBe(true);
    expect(options).toMatchObject([{ price: '6.00', source: 'rate_card', etaHours: 48 }]);
    expect(repo.saved[0].rawResponse).toMatchObject({ rateCardId: 'rc-sim-ESTANDAR', apiError: 'sin respuesta en 80 ms' });
  });

  it('couriers en paralelo: uno falla (tarifario) y otro responde (API)', async () => {
    const repo = new FakeCouriers([service('a', 'ESTANDAR'), service('b', 'ESTANDAR', 'other')], [rateCard('a-ESTANDAR', '6.00')]);
    const failing = new FakePort('simulator', async () => {
      throw new Error('HTTP 503');
    });
    const ok = new FakePort('other', async () => [apiQuote('ESTANDAR', '5.10')]);
    const options = await new CourierQuoteAggregator({} as Database, repo, adapters(failing, ok), config).quote(input);
    expect(options.map((o) => [o.courier.code, o.price, o.source])).toEqual([
      ['b', '5.10', 'api'],
      ['a', '6.00', 'rate_card'],
    ]);
  });

  it('si la API responde sin un servicio, ese servicio no cubre el destino; sin tarifa tampoco se ofrece', async () => {
    const repo = new FakeCouriers([service('sim', 'ESTANDAR'), service('sim', 'EXPRESS')], []);
    const port = new FakePort('simulator', async () => [apiQuote('ESTANDAR', '6.24')]);
    expect((await new CourierQuoteAggregator({} as Database, repo, adapters(port), config).quote(input)).map((o) => o.service.code)).toEqual(['ESTANDAR']);

    const noApi = new FakeCouriers([service('sim', 'ESTANDAR', 'no-habilitado')], []);
    expect(await new CourierQuoteAggregator({} as Database, noApi, adapters(), config).quote(input)).toEqual([]);
  });

  it('descarta servicios cuyo peso máximo es menor al paquete', async () => {
    const repo = new FakeCouriers([service('sim', 'EXPRESS', 'simulator', 1)], [rateCard('sim-EXPRESS', '8.50')]);
    expect(await new CourierQuoteAggregator({} as Database, repo, adapters(), config).quote(input)).toEqual([]);
  });

  it('withDeadline rechaza aunque el adaptador ignore la señal', async () => {
    await expect(withDeadline(() => new Promise(() => undefined), 20)).rejects.toThrow('sin respuesta en 20 ms');
  });
});
