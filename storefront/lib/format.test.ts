import { describe, expect, it } from 'vitest';
import { discountPercent, formatEta, formatMoney, formatSlot, formatTime } from './format';

describe('formatos de la tienda', () => {
  it('dinero en dólares con formato de Ecuador', () => {
    expect(formatMoney('49.90')).toMatch(/49,90/);
    expect(formatMoney('49.90')).toContain('$');
    expect(formatMoney('1234.5')).toMatch(/1\.234,50/);
    expect(formatMoney(null)).toBe('');
    expect(formatMoney('abc')).toBe('');
  });

  it('porcentaje de descuento', () => {
    expect(discountPercent('49.90', '69.90')).toBe(29);
    expect(discountPercent('49.90', '49.90')).toBeNull();
    expect(discountPercent('49.90', null)).toBeNull();
  });

  it('horas en America/Guayaquil (UTC-5) aunque el servidor esté en UTC', () => {
    expect(formatTime('2026-10-06T15:00:00Z')).toBe('10:00');
    expect(formatSlot('2026-10-06T15:00:00Z', '2026-10-06T17:00:00Z')).toMatch(/10:00–12:00$/);
  });

  it('ETA legible', () => {
    expect(formatEta(30)).toBe('1 min');
    expect(formatEta(270)).toBe('5 min');
    expect(formatEta(3720)).toBe('1 h 2 min');
    expect(formatEta(7200)).toBe('2 h');
  });
});
