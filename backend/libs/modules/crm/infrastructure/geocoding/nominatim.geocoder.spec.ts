import { createServer, IncomingMessage, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { AppConfig } from '../../../../shared-kernel';
import { GeocoderUnavailableError } from '../../application/ports';
import { NominatimGeocoder, toCandidate } from './nominatim.geocoder';

function geocoder(url: string | null, timeoutMs = 500): NominatimGeocoder {
  return new NominatimGeocoder({ crm: { nominatimUrl: url, nominatimTimeoutMs: timeoutMs, nominatimUserAgent: 'tests/1.0' } } as unknown as AppConfig);
}

describe('NominatimGeocoder', () => {
  let server: Server;
  let base: string;
  let last: IncomingMessage | null = null;
  let reply: (res: import('node:http').ServerResponse) => void;

  beforeAll(async () => {
    server = createServer((req, res) => {
      last = req;
      reply(res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('envía la consulta estructurada (Ecuador, español, User-Agent) y traduce los resultados', async () => {
    reply = (res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify([
          {
            lat: '-0.1765',
            lon: '-78.4800',
            display_name: 'Avenida Amazonas, Iñaquito, Quito, Pichincha, Ecuador',
            category: 'highway',
            type: 'primary',
            addresstype: 'road',
            address: { road: 'Avenida Amazonas', neighbourhood: 'Iñaquito', city: 'Quito', state: 'Pichincha' },
          },
        ]),
      );
    };
    const found = await geocoder(base).search({ type: 'structured', street: 'Av. Amazonas', city: 'Quito', state: 'Pichincha', accuracy: 'street' });
    const url = new URL(last!.url!, base);
    expect(url.pathname).toBe('/search');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      format: 'jsonv2',
      countrycodes: 'ec',
      'accept-language': 'es',
      street: 'Av. Amazonas',
      city: 'Quito',
      state: 'Pichincha',
      country: 'Ecuador',
    });
    expect(last!.headers['user-agent']).toBe('tests/1.0');
    expect(found).toEqual([
      { lat: -0.1765, lng: -78.48, kind: 'street', displayName: 'Avenida Amazonas, Iñaquito, Quito, Pichincha, Ecuador', city: 'Quito', province: 'Pichincha', neighborhood: 'Iñaquito' },
    ]);
  });

  it('traduce el tipo de resultado (casa, vía, área)', () => {
    const base = { lat: '0', lon: '0', display_name: 'x' };
    expect(toCandidate({ ...base, address: { house_number: 'N34-120' } })?.kind).toBe('house');
    expect(toCandidate({ ...base, category: 'highway' })?.kind).toBe('street');
    expect(toCandidate({ ...base, category: 'place', addresstype: 'suburb', address: { town: 'Cumbayá' } })).toMatchObject({ kind: 'area', city: 'Cumbayá' });
    expect(toCandidate({ ...base, lat: 'abc' })).toBeNull();
  });

  it('un error HTTP o un timeout se reporta como no disponible', async () => {
    reply = (res) => {
      res.statusCode = 503;
      res.end('ocupado');
    };
    await expect(geocoder(base).search({ type: 'free', q: 'Iñaquito, Quito', accuracy: 'approximate' })).rejects.toBeInstanceOf(GeocoderUnavailableError);
    reply = () => undefined; // nunca responde
    await expect(geocoder(base, 100).search({ type: 'free', q: 'x', accuracy: 'approximate' })).rejects.toThrow(/sin respuesta en 100 ms/);
  });

  it('sin NOMINATIM_URL queda deshabilitado', async () => {
    const g = geocoder(null);
    expect(g.enabled).toBe(false);
    await expect(g.search({ type: 'free', q: 'x', accuracy: 'approximate' })).resolves.toEqual([]);
  });
});
