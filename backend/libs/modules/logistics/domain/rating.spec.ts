import { assertRateable, normalizeRating, RATING_WINDOW_DAYS } from './rating';

describe('Calificaciones', () => {
  it('normaliza etiquetas (minúsculas, sin duplicados) y el comentario vacío', () => {
    expect(normalizeRating('customer', { score: 5, tags: ['Puntual', 'puntual', ' amable '], comment: '  ' })).toEqual({
      score: 5,
      tags: ['puntual', 'amable'],
      comment: null,
    });
  });

  it.each([0, 6, 3.5])('rechaza el puntaje %p', (score) => {
    expect(() => normalizeRating('customer', { score })).toThrow(expect.objectContaining({ code: 'INVALID_RATING' }));
  });

  it('las etiquetas dependen de quién califica', () => {
    expect(() => normalizeRating('customer', { score: 2, tags: ['no_contesta'] })).toThrow(
      expect.objectContaining({ code: 'INVALID_RATING_TAG' }),
    );
    expect(normalizeRating('rider', { score: 2, tags: ['no_contesta'] }).tags).toEqual(['no_contesta']);
  });

  it('solo entregas completadas y dentro del plazo', () => {
    const deliveredAt = new Date('2026-09-20T15:00:00Z');
    const day = 24 * 60 * 60 * 1000;
    expect(() => assertRateable({ id: 's', status: 'in_transit', deliveredAt: null }, deliveredAt)).toThrow(
      expect.objectContaining({ code: 'SHIPMENT_NOT_RATEABLE', details: expect.objectContaining({ reason: 'NOT_DELIVERED' }) }),
    );
    expect(() => assertRateable({ id: 's', status: 'delivered', deliveredAt }, new Date(deliveredAt.getTime() + RATING_WINDOW_DAYS * day))).not.toThrow();
    expect(() => assertRateable({ id: 's', status: 'delivered', deliveredAt }, new Date(deliveredAt.getTime() + RATING_WINDOW_DAYS * day + 1))).toThrow(
      expect.objectContaining({ details: expect.objectContaining({ reason: 'WINDOW_CLOSED' }) }),
    );
  });
});
