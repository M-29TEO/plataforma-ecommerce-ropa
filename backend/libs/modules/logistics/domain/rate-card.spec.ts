import { priceFromRateCards, RateCard } from './rate-card';

let seq = 0;
const card = (destProvince: string, destCity: string | null, from: number, to: number, price: string, extra = '0.50', opts: Partial<RateCard> = {}): RateCard => ({
  id: String(++seq),
  courierServiceId: 's1',
  originCity: 'Quito',
  destProvince,
  destCity,
  weightFromKg: from,
  weightToKg: to,
  price,
  extraKgPrice: extra,
  validFrom: '2026-01-01',
  validTo: null,
  ...opts,
});

const cards = [
  card('Pichincha', 'Quito', 0, 2, '3.50'),
  card('Pichincha', 'Quito', 2, 5, '4.50'),
  card('Pichincha', null, 0, 2, '4.50'),
  card('Pichincha', null, 2, 5, '5.75', '0.75'),
  card('*', null, 0, 2, '7.50'),
  card('*', null, 2, 5, '9.50', '1.25'),
];

const q = (destProvince: string, destCity: string | null, kg: number, date = '2026-09-29') => ({ originCity: 'QUITO', destProvince, destCity, kg, date });

describe('priceFromRateCards', () => {
  it('la tarifa más específica gana: ciudad > provincia > "*"', () => {
    expect(priceFromRateCards(cards, q('pichincha', 'Quito', 1))?.priceCents).toBe(350);
    expect(priceFromRateCards(cards, q('Pichincha', 'Cumbayá', 1))?.priceCents).toBe(450);
    expect(priceFromRateCards(cards, q('Loja', 'Loja', 1))?.priceCents).toBe(750);
  });

  it('tramos (desde, hasta] y kg adicionales sobre el último', () => {
    expect(priceFromRateCards(cards, q('Pichincha', 'Quito', 2))?.priceCents).toBe(350);
    expect(priceFromRateCards(cards, q('Pichincha', 'Quito', 2.1))?.priceCents).toBe(450);
    expect(priceFromRateCards(cards, q('Pichincha', 'Cayambe', 6.2))?.priceCents).toBe(575 + 2 * 75);
  });

  it('respeta la vigencia y el origen; sin tarifa → null', () => {
    const expired = [card('Guayas', null, 0, 5, '6.00', '1.00', { validTo: '2026-06-30' })];
    expect(priceFromRateCards(expired, q('Guayas', 'Guayaquil', 1))).toBeNull();
    expect(priceFromRateCards(cards, { ...q('Pichincha', 'Quito', 1), originCity: 'Cuenca' })).toBeNull();
    expect(priceFromRateCards(cards.slice(0, 4), q('Galápagos', 'Puerto Ayora', 1))).toBeNull();
  });
});
