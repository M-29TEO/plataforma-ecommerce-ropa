import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Database } from '../../libs/shared-kernel';
import { createTenant, TestTenant, tokenFor } from '../support/fixtures';
import { createTestApp } from '../support/test-app';

// Coordenadas reales aproximadas.
const QUITO_NORTE = { lat: -0.1500, lng: -78.4850 };
const QUITO_SUR = { lat: -0.2800, lng: -78.5450 };
const GUAYAQUIL = { lat: -2.1700, lng: -79.9224 };

describe('Inventario · bodegas (HTTP)', () => {
  let app: INestApplication;
  let db: Database;
  let t: TestTenant;
  let auth: string;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
    t = await createTenant(db);
    auth = `Bearer ${tokenFor(t)}`;
  });

  afterAll(async () => {
    await app.close();
  });

  const create = (body: Record<string, unknown>, token = auth) =>
    request(app.getHttpServer()).post('/v1/inventory/warehouses').set('Authorization', token).send(body);

  const payload = (code: string, location: { lat: number; lng: number }, city = 'Quito') => ({
    code,
    name: `Bodega ${code}`,
    type: 'warehouse',
    address: { mainStreet: 'Av. Amazonas', number: 'N34-12' },
    location,
    city,
  });

  it('crea una bodega con ubicación PostGIS y la devuelve con lat/lng', async () => {
    const res = await create(payload('uio-norte', QUITO_NORTE)).expect(201);
    expect(res.body).toMatchObject({
      code: 'UIO-NORTE',
      type: 'warehouse',
      city: 'Quito',
      shipsOnline: true,
      isPickupPoint: false,
      active: true,
    });
    expect(res.body.location.lat).toBeCloseTo(QUITO_NORTE.lat, 6);
    expect(res.body.location.lng).toBeCloseTo(QUITO_NORTE.lng, 6);

    const { rows } = await db.query(
      `SELECT ST_AsText(location::geometry) AS wkt FROM inventory.warehouses WHERE id = $1`,
      [res.body.id],
    );
    expect(rows[0].wkt).toBe('POINT(-78.485 -0.15)');
  });

  it('rechaza código duplicado, coordenadas inválidas y campos desconocidos', async () => {
    await create(payload('DUP-1', QUITO_SUR)).expect(201);
    const dup = await create(payload('dup-1', QUITO_SUR)).expect(409);
    expect(dup.body.error.code).toBe('WAREHOUSE_CODE_TAKEN');

    await create(payload('BAD-1', { lat: 95, lng: 0 })).expect(400);
    await create({ ...payload('BAD-2', QUITO_SUR), hacker: true }).expect(400);
    await create({ ...payload('BAD-3', QUITO_SUR), type: 'garage' }).expect(400);
    // La dirección ya no es un objeto libre: claves conocidas y largos acotados.
    await create({ ...payload('BAD-4', QUITO_SUR), address: { mainStreet: 'Av. Amazonas', extra: 'x' } }).expect(400);
    await create({ ...payload('BAD-5', QUITO_SUR), address: { mainStreet: 'x'.repeat(201) } }).expect(400);
  });

  it('exige autenticación y el permiso inventory.warehouse.write', async () => {
    await request(app.getHttpServer()).post('/v1/inventory/warehouses').send(payload('X-1', QUITO_SUR)).expect(401);
    await create(payload('X-2', QUITO_SUR), 'Bearer token-falso').expect(401);
    const res = await create(payload('X-3', QUITO_SUR), `Bearer ${tokenFor(t, ['inventory.read'])}`).expect(403);
    expect(res.body.message).toBe('No tienes permiso para esta operación'); // no enumera el permiso que falta
  });

  it('obtiene, lista, edita y desactiva (borrado lógico)', async () => {
    const created = (await create(payload('GYE-01', GUAYAQUIL, 'Guayaquil')).expect(201)).body;
    const server = app.getHttpServer();

    const got = await request(server).get(`/v1/inventory/warehouses/${created.id}`).set('Authorization', auth).expect(200);
    expect(got.body.code).toBe('GYE-01');

    const byCity = await request(server)
      .get('/v1/inventory/warehouses?city=guayaquil')
      .set('Authorization', auth)
      .expect(200);
    expect(byCity.body.map((w: { id: string }) => w.id)).toEqual([created.id]);

    const updated = await request(server)
      .patch(`/v1/inventory/warehouses/${created.id}`)
      .set('Authorization', auth)
      .send({ name: 'Bodega Guayaquil Centro', isPickupPoint: true, location: { lat: -2.19, lng: -79.89 } })
      .expect(200);
    expect(updated.body).toMatchObject({ name: 'Bodega Guayaquil Centro', isPickupPoint: true, code: 'GYE-01' });
    expect(updated.body.location.lat).toBeCloseTo(-2.19, 6);

    await request(server)
      .patch(`/v1/inventory/warehouses/${created.id}`)
      .set('Authorization', auth)
      .send({ code: 'OTRO' })
      .expect(400);

    const deleted = await request(server)
      .delete(`/v1/inventory/warehouses/${created.id}`)
      .set('Authorization', auth)
      .expect(200);
    expect(deleted.body.active).toBe(false);

    const active = await request(server).get('/v1/inventory/warehouses?active=true').set('Authorization', auth).expect(200);
    expect(active.body.map((w: { id: string }) => w.id)).not.toContain(created.id);
  });

  it('no expone bodegas de otro tenant', async () => {
    const created = (await create(payload('PRIV-1', QUITO_SUR)).expect(201)).body;
    const other = await createTenant(db);
    const res = await request(app.getHttpServer())
      .get(`/v1/inventory/warehouses/${created.id}`)
      .set('Authorization', `Bearer ${tokenFor(other)}`)
      .expect(404);
    expect(res.body.error.code).toBe('WAREHOUSE_NOT_FOUND');
  });

  it('busca bodegas cercanas ordenadas por distancia (ST_DWithin + KNN)', async () => {
    const nearTenant = await createTenant(db);
    const token = `Bearer ${tokenFor(nearTenant)}`;
    await create(payload('N-NORTE', QUITO_NORTE), token).expect(201);
    await create(payload('N-SUR', QUITO_SUR), token).expect(201);
    await create(payload('N-GYE', GUAYAQUIL, 'Guayaquil'), token).expect(201);

    // Punto en el centro-norte de Quito.
    const res = await request(app.getHttpServer())
      .get('/v1/inventory/warehouses/nearby?lat=-0.1807&lng=-78.4678&radiusKm=30')
      .set('Authorization', token)
      .expect(200);

    expect(res.body.map((w: { code: string }) => w.code)).toEqual(['N-NORTE', 'N-SUR']);
    expect(res.body[0].distanceMeters).toBeGreaterThan(3000);
    expect(res.body[0].distanceMeters).toBeLessThan(5000);
    expect(res.body[0].distanceMeters).toBeLessThan(res.body[1].distanceMeters);
  });
});
