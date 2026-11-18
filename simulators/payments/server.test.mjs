// node --test: flujo completo del simulador contra una "tienda" falsa que recibe el webhook.
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { canonicalParams, createPaymentSimulator, hmacHex, SIGNATURE_HEADER, signWebhook } from './server.mjs';

const SECRET = 'secreto-de-prueba';
const received = [];
let shop;
let sim;
let base;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function signedParams(overrides = {}) {
  const params = {
    ref: `ps_${Math.random().toString(16).slice(2)}`,
    amount: '46.00',
    currency: 'USD',
    order: '1001',
    method: 'card',
    exp: String(Math.floor(Date.now() / 1000) + 900),
    return: 'http://localhost/checkout/resultado?paymentId=x',
    ...overrides,
  };
  return { ...params, sig: hmacHex(SECRET, canonicalParams(params)) };
}

before(async () => {
  shop = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ body, signature: req.headers[SIGNATURE_HEADER] });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"received":true}');
    });
  });
  const shopPort = await listen(shop);
  sim = createPaymentSimulator({ webhookUrl: `http://127.0.0.1:${shopPort}/webhook`, webhookSecret: SECRET, log: { error() {} } });
  base = `http://127.0.0.1:${await listen(sim.server)}`;
});

after(() => {
  sim.server.close();
  shop.close();
});

test('muestra la página de pago solo con la firma correcta', async () => {
  const ok = await fetch(`${base}/pay?${new URLSearchParams(signedParams())}`);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /Aprobar pago/);

  const tampered = { ...signedParams(), amount: '1.00' }; // monto adulterado, firma del original
  const bad = await fetch(`${base}/pay?${new URLSearchParams(tampered)}`);
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /Firma del pedido de pago inválida/);
});

test('aprobar envía un webhook firmado con HMAC sobre t.cuerpo; el doble clic no duplica', async () => {
  const params = signedParams();
  const form = new URLSearchParams({ ...params, decision: 'approve' });
  const first = await fetch(`${base}/pay/decision`, { method: 'POST', body: form });
  assert.match(await first.text(), /Pago aprobado/);
  const second = await fetch(`${base}/pay/decision`, { method: 'POST', body: form });
  assert.match(await second.text(), /ya se procesó/);

  const mine = received.filter((r) => JSON.parse(r.body).data.reference === params.ref);
  assert.equal(mine.length, 1);
  const event = JSON.parse(mine[0].body);
  assert.equal(event.type, 'payment.approved');
  assert.equal(event.data.amount, '46.00');
  const [, t, v1] = mine[0].signature.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
  assert.equal(v1, hmacHex(SECRET, `${t}.${mine[0].body}`));
});

test('rechazar envía payment.rejected con el motivo', async () => {
  const params = signedParams();
  await fetch(`${base}/pay/decision`, { method: 'POST', body: new URLSearchParams({ ...params, decision: 'reject', reason: 'INSUFFICIENT_FUNDS' }) });
  const event = JSON.parse(received.find((r) => JSON.parse(r.body).data.reference === params.ref).body);
  assert.equal(event.type, 'payment.rejected');
  assert.deepEqual([event.data.failureCode, event.data.failureMessage], ['INSUFFICIENT_FUNDS', 'Fondos insuficientes']);
});

test('reenviar manda el MISMO id de evento (la tienda debe tratarlo como duplicado)', async () => {
  const params = signedParams();
  await fetch(`${base}/pay/decision`, { method: 'POST', body: new URLSearchParams({ ...params, decision: 'approve' }) });
  const eventId = [...sim.events.values()].find((r) => r.event.data.reference === params.ref).event.id;
  await fetch(`${base}/events/${eventId}/resend`, { method: 'POST' });
  const ids = received.map((r) => JSON.parse(r.body).id).filter((id) => id === eventId);
  assert.equal(ids.length, 2);
});

test('un pedido de pago vencido no se puede pagar', async () => {
  const res = await fetch(`${base}/pay?${new URLSearchParams(signedParams({ exp: String(Math.floor(Date.now() / 1000) - 5) }))}`);
  assert.equal(res.status, 410);
});

function postRefund(body, secret = SECRET) {
  const raw = JSON.stringify(body);
  return fetch(`${base}/refunds`, { method: 'POST', headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signWebhook(secret, raw) }, body: raw });
}

test('reverso: parcial e idempotente por refundId, sin superar lo cobrado', async () => {
  const params = signedParams();
  await fetch(`${base}/pay/decision`, { method: 'POST', body: new URLSearchParams({ ...params, decision: 'approve' }) });

  const first = await postRefund({ refundId: 'r-1', reference: params.ref, amount: '20.00', currency: 'USD' });
  assert.equal(first.status, 201);
  const created = await first.json();
  assert.equal(created.status, 'succeeded');
  assert.match(created.id, /^rf_[0-9a-f]{32}$/);

  const again = await postRefund({ refundId: 'r-1', reference: params.ref, amount: '20.00' });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).id, created.id);

  const tooMuch = await postRefund({ refundId: 'r-2', reference: params.ref, amount: '26.01' });
  assert.equal(tooMuch.status, 422);
  assert.equal((await tooMuch.json()).error.code, 'REFUND_EXCEEDS_PAYMENT');
  assert.equal((await postRefund({ refundId: 'r-3', reference: params.ref, amount: '26.00' })).status, 201);
});

test('reverso: firma obligatoria y solo sobre cobros aprobados', async () => {
  const bad = await postRefund({ refundId: 'x', reference: 'ps_x', amount: '1.00' }, 'otro-secreto');
  assert.equal(bad.status, 401);

  const params = signedParams();
  await fetch(`${base}/pay/decision`, { method: 'POST', body: new URLSearchParams({ ...params, decision: 'reject' }) });
  const rejected = await postRefund({ refundId: 'r-rechazado', reference: params.ref, amount: '1.00' });
  assert.equal(rejected.status, 404);
  assert.equal((await postRefund({ refundId: 'r-nada', reference: 'ps_inexistente', amount: '1.00' })).status, 404);
});
