// node --test: tarifario, guía PDF, máquina de estados y webhooks firmados contra una "tienda" falsa.
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';
import { CODE39, code39Bars, renderLabelPdf } from './label-pdf.mjs';
import { API_KEY_HEADER, createCourierSimulator, hmacHex, MAX_DELIVERY_ATTEMPTS, nextStatus, SIGNATURE_HEADER } from './server.mjs';
import { chargeableWeightKg, destinationGroup, quote, tariffPrice } from './tariffs.mjs';

const SECRET = 'secreto-de-prueba';
const API_KEY = 'clave-api-de-prueba';
const QUITO = { city: 'Quito', province: 'Pichincha' };

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}

async function waitFor(fn, ms = 2_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Tiempo de espera agotado');
}

/** Verificación idéntica a la del backend: t dentro de la firma y HMAC del cuerpo crudo. */
function verify(body, header) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  return parts.v1 === hmacHex(SECRET, `${parts.t}.${body}`);
}

describe('tarifario', () => {
  test('grupos de destino relativos al origen', () => {
    assert.equal(destinationGroup(QUITO, { city: 'quito', province: 'PICHINCHA' }), 'local');
    assert.equal(destinationGroup(QUITO, { city: 'Cayambe', province: 'Pichincha' }), 'provincial');
    assert.equal(destinationGroup(QUITO, { city: 'Cuenca', province: 'Azuay' }), 'principal');
    assert.equal(destinationGroup(QUITO, { city: 'Loja', province: 'Loja' }), 'nacional');
    assert.equal(destinationGroup(QUITO, { city: 'Puerto Ayora', province: 'Galápagos' }), null);
  });

  test('peso facturable: el mayor entre real y volumétrico, hacia arriba a 0,1 kg', () => {
    assert.equal(chargeableWeightKg(0.62), 0.7);
    assert.equal(chargeableWeightKg(1, 30 * 20 * 15), 1.8); // 9000 cm³ / 5000
    assert.equal(chargeableWeightKg(0), 0.1);
  });

  test('tramos y kg adicionales sobre el último tramo', () => {
    assert.deepEqual(tariffPrice('ESTANDAR', 'local', 1.5), { price: 3.5, etaHours: 24 });
    assert.deepEqual(tariffPrice('ESTANDAR', 'local', 4), { price: 4.5, etaHours: 24 });
    assert.equal(tariffPrice('ESTANDAR', 'local', 6.2).price, 4.5 + 2 * 0.5);
    assert.equal(tariffPrice('EXPRESS', 'local', 16), null); // excede el máximo del servicio
  });

  test('la API suma el recargo por combustible del 4 %', () => {
    const q = quote({ origin: QUITO, destination: { city: 'Guayaquil', province: 'Guayas' }, weightKg: 1.2 });
    assert.deepEqual(
      q.options.map((o) => [o.serviceCode, o.price, o.etaHours]),
      [
        ['ESTANDAR', '6.24', 48],
        ['EXPRESS', '8.84', 24],
      ],
    );
  });
});

describe('guía PDF', () => {
  test('cada carácter Code 39 tiene 9 elementos y exactamente 3 anchos', () => {
    for (const [ch, pattern] of Object.entries(CODE39)) {
      assert.equal(pattern.length, 9, ch);
      assert.equal([...pattern].filter((c) => c === 'w').length, 3, ch);
    }
    const { bars } = code39Bars('SIM1EC');
    assert.equal(bars.length, (6 + 2) * 5);
    assert.throws(() => code39Bars('ñ'), /no soportado/);
  });

  test('PDF válido: cabecera, xref con offsets reales y fin de archivo', () => {
    const pdf = renderLabelPdf({
      trackingNumber: 'SIM123456789EC',
      serviceCode: 'ESTANDAR',
      serviceName: 'Estándar',
      sender: { name: 'Moda Demo (bodega)', address: 'Av. Amazonas', city: 'Quito', phone: '022000000' },
      recipient: { name: 'Ana Pérez', address: 'Calle Larga 7-45 y Borrero, casa esquinera', city: 'Cuenca', province: 'Azuay' },
      weightKg: 1.2,
      packages: 1,
      codAmount: 45.5,
      reference: '100123',
    });
    const text = pdf.toString('latin1');
    assert.ok(text.startsWith('%PDF-1.4'));
    assert.ok(text.trimEnd().endsWith('%%EOF'));
    const startxref = Number(text.match(/startxref\n(\d+)/)[1]);
    assert.equal(text.slice(startxref, startxref + 4), 'xref');
    const offsets = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    assert.equal(offsets.length, 7);
    offsets.forEach((o, i) => assert.equal(text.slice(o, o + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`));
    assert.match(text, /\(Ana P\xe9rez\) Tj/); // WinAnsi: é en un byte
    assert.match(text, /COBRAR CONTRA ENTREGA: USD 45\.50/);
  });
});

describe('máquina de estados', () => {
  test('reparto con fallos y devolución tras el máximo de intentos', () => {
    const always = () => 0;
    const never = () => 1;
    assert.equal(nextStatus({ status: 'GUIA_GENERADA' }), 'RECOLECTADO');
    assert.equal(nextStatus({ status: 'EN_REPARTO' }, never, 0.1), 'ENTREGADO');
    assert.equal(nextStatus({ status: 'EN_REPARTO' }, always, 0.1), 'NOVEDAD');
    assert.equal(nextStatus({ status: 'NOVEDAD', failedAttempts: 1 }), 'EN_REPARTO');
    assert.equal(nextStatus({ status: 'NOVEDAD', failedAttempts: MAX_DELIVERY_ATTEMPTS }), 'DEVUELTO');
    assert.equal(nextStatus({ status: 'ENTREGADO' }), null);
  });
});

describe('API HTTP', () => {
  const received = [];
  let shop;
  let sim;
  let base;

  const api = (path, { method = 'GET', body, key = API_KEY } = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(key ? { [API_KEY_HEADER]: key } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const newShipment = (overrides = {}) => ({
    reference: `P-${Math.random().toString(16).slice(2, 8)}`,
    serviceCode: 'ESTANDAR',
    sender: { name: 'Moda Demo', address: 'Av. Amazonas', ...QUITO },
    recipient: { name: 'Ana Pérez', address: 'Av. 9 de Octubre 100', city: 'Guayaquil', province: 'Guayas', phone: '0991234567' },
    weightKg: 1.2,
    codAmount: 0,
    ...overrides,
  });

  before(async () => {
    shop = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ body, event: JSON.parse(body), signature: req.headers[SIGNATURE_HEADER] });
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"received":true}');
      });
    });
    const shopPort = await listen(shop);
    sim = createCourierSimulator({
      webhookUrl: `http://127.0.0.1:${shopPort}/webhook`,
      webhookSecret: SECRET,
      apiKey: API_KEY,
      config: { autoAdvance: false },
      log: { error() {} },
    });
    base = `http://127.0.0.1:${await listen(sim.server)}`;
  });

  after(async () => {
    await close(sim.server);
    await close(shop);
  });

  beforeEach(async () => {
    received.length = 0;
    await api('/admin/config', { method: 'POST', body: { latencyMs: 0, failRate: 0, autoAdvance: false } });
  });

  test('sin API key válida responde 401', async () => {
    assert.equal((await api('/v1/quotes', { method: 'POST', body: {}, key: null })).status, 401);
    assert.equal((await api('/v1/quotes', { method: 'POST', body: {}, key: 'otra' })).status, 401);
  });

  test('cotiza por servicio y valida la entrada', async () => {
    const res = await api('/v1/quotes', {
      method: 'POST',
      body: { origin: QUITO, destination: { city: 'Quito', province: 'Pichincha' }, weightKg: 0.8 },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.quoteId, /^q_/);
    assert.equal(body.destinationGroup, 'local');
    assert.deepEqual(body.options.map((o) => o.price), ['3.64', '5.20']);

    const bad = await api('/v1/quotes', { method: 'POST', body: { origin: QUITO, destination: { city: 'Quito' }, weightKg: 1 } });
    assert.equal(bad.status, 422);
    assert.equal((await bad.json()).error.code, 'INVALID_REQUEST');
  });

  test('latencia y fallos configurables (para probar el timeout y el respaldo de la tienda)', async () => {
    await api('/admin/config', { method: 'POST', body: { failRate: 1 } });
    const failed = await api('/v1/quotes', { method: 'POST', body: { origin: QUITO, destination: QUITO, weightKg: 1 } });
    assert.equal(failed.status, 503);

    await api('/admin/config', { method: 'POST', body: { failRate: 0, latencyMs: 150 } });
    const started = Date.now();
    assert.equal((await api('/v1/quotes', { method: 'POST', body: { origin: QUITO, destination: QUITO, weightKg: 1 } })).status, 200);
    assert.ok(Date.now() - started >= 140);

    assert.equal((await api('/admin/config', { method: 'POST', body: { failRate: 2 } })).status, 422);
  });

  test('crea la guía (idempotente por referencia), notifica con firma válida y entrega el PDF', async () => {
    const body = newShipment({ codAmount: 45.5 });
    const res = await api('/v1/shipments', { method: 'POST', body });
    assert.equal(res.status, 201);
    const created = await res.json();
    assert.match(created.trackingNumber, /^SIM\d{9}EC$/);
    assert.equal(created.status, 'GUIA_GENERADA');
    assert.equal(created.price, '6.24');

    const again = await api('/v1/shipments', { method: 'POST', body });
    assert.equal(again.status, 200);
    assert.equal((await again.json()).trackingNumber, created.trackingNumber);

    const hook = await waitFor(() => received.find((r) => r.event.data.trackingNumber === created.trackingNumber));
    assert.ok(verify(hook.body, hook.signature));
    assert.equal(hook.event.type, 'shipment.status_changed');
    assert.equal(hook.event.data.status, 'GUIA_GENERADA');
    assert.equal(hook.event.data.reference, body.reference);

    const label = await api(`/v1/shipments/${created.trackingNumber}/label.pdf`);
    assert.equal(label.headers.get('content-type'), 'application/pdf');
    assert.ok(Buffer.from(await label.arrayBuffer()).subarray(0, 5).equals(Buffer.from('%PDF-')));
  });

  test('sin cobertura (Galápagos) responde 422 NO_COVERAGE', async () => {
    const res = await api('/v1/shipments', {
      method: 'POST',
      body: newShipment({ recipient: { name: 'Eva', address: 'Av. Charles Darwin', city: 'Puerto Ayora', province: 'Galápagos' } }),
    });
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error.code, 'NO_COVERAGE');
  });

  test('avance manual hasta entregado; transición inválida → 409; cobro contra entrega en el webhook', async () => {
    const { trackingNumber: tn } = await (await api('/v1/shipments', { method: 'POST', body: newShipment({ codAmount: 20 }) })).json();
    assert.equal((await api(`/admin/shipments/${tn}/advance`, { method: 'POST', body: { status: 'ENTREGADO' } })).status, 409);

    for (const expected of ['RECOLECTADO', 'EN_TRANSITO', 'EN_REPARTO']) {
      const res = await api(`/admin/shipments/${tn}/advance`, { method: 'POST' });
      assert.equal((await res.json()).status, expected);
    }
    await api(`/admin/shipments/${tn}/advance`, { method: 'POST', body: { status: 'NOVEDAD' } });
    await api(`/admin/shipments/${tn}/advance`, { method: 'POST', body: { status: 'EN_REPARTO' } });
    const done = await (await api(`/admin/shipments/${tn}/advance`, { method: 'POST', body: { status: 'ENTREGADO' } })).json();
    assert.equal(done.status, 'ENTREGADO');
    assert.equal(done.failedAttempts, 1);
    assert.equal(done.history.length, 7);

    const hooks = await waitFor(() => {
      const mine = received.filter((r) => r.event.data.trackingNumber === tn);
      return mine.length === 7 ? mine : null;
    });
    const delivered = hooks.find((h) => h.event.data.status === 'ENTREGADO');
    assert.equal(delivered.event.data.codCollected, '20.00');
    assert.ok(hooks.every((h) => verify(h.body, h.signature)));
    assert.equal((await api(`/admin/shipments/${tn}/advance`, { method: 'POST' })).status, 409);
  });

  test('anular solo antes de la recolección', async () => {
    const { trackingNumber: tn } = await (await api('/v1/shipments', { method: 'POST', body: newShipment() })).json();
    assert.equal((await (await api(`/v1/shipments/${tn}/cancel`, { method: 'POST' })).json()).status, 'ANULADO');
    assert.equal((await api(`/v1/shipments/${tn}/cancel`, { method: 'POST' })).status, 409);
  });

  test('avance automático cada stepMs hasta un estado final', async () => {
    await api('/admin/config', { method: 'POST', body: { autoAdvance: true, stepMs: 20, failedAttemptRate: 0 } });
    const { trackingNumber: tn } = await (await api('/v1/shipments', { method: 'POST', body: newShipment() })).json();
    await waitFor(() => sim.shipments.get(tn).status === 'ENTREGADO');
    assert.deepEqual(
      sim.shipments.get(tn).history.map((h) => h.status),
      ['GUIA_GENERADA', 'RECOLECTADO', 'EN_TRANSITO', 'EN_REPARTO', 'ENTREGADO'],
    );
  });

  test('reenviar un evento entrega el MISMO id (la tienda debe deduplicar)', async () => {
    const { trackingNumber: tn } = await (await api('/v1/shipments', { method: 'POST', body: newShipment() })).json();
    const first = await waitFor(() => received.find((r) => r.event.data.trackingNumber === tn));
    const res = await fetch(`${base}/events/${first.event.id}/resend`, { method: 'POST' });
    assert.equal((await res.json()).delivered, true);
    const copies = await waitFor(() => {
      const c = received.filter((r) => r.event.id === first.event.id);
      return c.length === 2 ? c : null;
    });
    assert.equal(copies[0].body, copies[1].body);
  });
});
