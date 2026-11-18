import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { findSystemRole, SystemRoleCode } from '../../libs/modules/iam/domain/system-roles';
import { Database, signAccessToken } from '../../libs/shared-kernel';
import { createTenant, TestTenant } from '../support/fixtures';
import { createTestApp } from '../support/test-app';

/** PNG de 1×1 válido. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/**
 * Administración del catálogo desde el backoffice (HTTP + PostgreSQL): productos, variantes,
 * precios masivos, tablas auxiliares, fotos y búsqueda de variantes por código de barras.
 */
describe('Catálogo: administración (integración)', () => {
  let app: INestApplication;
  let db: Database;
  let t: TestTenant;
  let other: TestTenant;
  const tag = randomUUID().slice(0, 8);

  let admin: string;
  let warehouse: string;
  let seller: string;
  let support: string;
  let customer: string;

  let categoryId: string;
  let otherCategoryId: string;
  let brandId: string;
  let colorId: string;
  let sizeS: string;
  let sizeM: string;

  const server = () => app.getHttpServer();
  const bearer = (tenant: TestTenant, role: SystemRoleCode) =>
    `Bearer ${signAccessToken(
      { id: tenant.userId, tenantId: tenant.tenantId, type: findSystemRole(role)!.userType, permissions: [...findSystemRole(role)!.permissions] },
      process.env.JWT_SECRET!,
    )}`;

  const auditRows = async (action: string, entityId: string) =>
    (
      await db.query<{ actor_id: string; before: any; after: any }>(
        `SELECT actor_id, before, after FROM platform.audit_log WHERE tenant_id = $1 AND action = $2 AND entity_id = $3 ORDER BY id`,
        [t.tenantId, action, entityId],
      )
    ).rows;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
    t = await createTenant(db);
    other = await createTenant(db);
    admin = bearer(t, 'admin');
    warehouse = bearer(t, 'warehouse');
    seller = bearer(t, 'seller');
    support = bearer(t, 'support');
    customer = bearer(t, 'customer');
    const o = await db.query<{ id: string }>(
      `INSERT INTO catalog.categories (tenant_id, name, slug, path) VALUES ($1, 'Ajena', 'ajena', 'ajena') RETURNING id`,
      [other.tenantId],
    );
    otherCategoryId = o.rows[0].id;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('tablas auxiliares', () => {
    it('crea marca, categorías con ruta, color y tallas, y las lista en lookups', async () => {
      const brand = await request(server()).post('/v1/catalog/admin/brands').set('Authorization', admin).send({ name: `Andina ${tag}` });
      expect(brand.status).toBe(201);
      brandId = brand.body.id;
      expect(brand.body.slug).toBe(`andina-${tag}`);

      const root = await request(server()).post('/v1/catalog/admin/categories').set('Authorization', admin).send({ name: 'Mujer' });
      expect(root.status).toBe(201);
      expect(root.body.path).toBe('mujer');
      const child = await request(server()).post('/v1/catalog/admin/categories').set('Authorization', admin).send({ name: 'Vestidos de Fiesta', parentId: root.body.id });
      expect(child.status).toBe(201);
      expect(child.body).toMatchObject({ path: 'mujer/vestidos-de-fiesta', parentId: root.body.id });
      categoryId = child.body.id;

      const color = await request(server()).post('/v1/catalog/admin/colors').set('Authorization', admin).send({ name: 'Rojo', hex: '#FF0000' });
      expect(color.status).toBe(201);
      expect(color.body.hex).toBe('#ff0000');
      colorId = color.body.id;

      const s = await request(server()).post('/v1/catalog/admin/sizes').set('Authorization', admin).send({ code: 'S', sizeSystem: 'alpha', sortOrder: 1 });
      const m = await request(server()).post('/v1/catalog/admin/sizes').set('Authorization', admin).send({ code: 'M', sizeSystem: 'alpha', sortOrder: 2 });
      expect([s.status, m.status]).toEqual([201, 201]);
      sizeS = s.body.id;
      sizeM = m.body.id;

      const lookups = await request(server()).get('/v1/catalog/admin/lookups').set('Authorization', seller);
      expect(lookups.status).toBe(200);
      expect(lookups.body.categories.map((c: { path: string }) => c.path)).toEqual(['mujer', 'mujer/vestidos-de-fiesta']);
      expect(lookups.body.sizes.map((x: { code: string }) => x.code)).toEqual(['S', 'M']);
      expect(lookups.body).toHaveProperty('sizeCharts');
      expect(lookups.body.brands).toHaveLength(1);
    });

    it('rechaza duplicados (409) y un padre de otra tienda (422)', async () => {
      const dupBrand = await request(server()).post('/v1/catalog/admin/brands').set('Authorization', admin).send({ name: `Andina ${tag}` });
      expect(dupBrand.status).toBe(409);
      expect(dupBrand.body.error.code).toBe('BRAND_TAKEN');
      const dupSize = await request(server()).post('/v1/catalog/admin/sizes').set('Authorization', admin).send({ code: 'S', sizeSystem: 'alpha' });
      expect(dupSize.body.error.code).toBe('SIZE_TAKEN');
      const dupColor = await request(server()).post('/v1/catalog/admin/colors').set('Authorization', admin).send({ name: 'Rojo' });
      expect(dupColor.body.error.code).toBe('COLOR_TAKEN');
      const badParent = await request(server()).post('/v1/catalog/admin/categories').set('Authorization', admin).send({ name: 'X', parentId: otherCategoryId });
      expect(badParent.status).toBe(422);
      expect(badParent.body.error.code).toBe('INVALID_REFERENCE');
    });
  });

  describe('productos', () => {
    let productId: string;
    let updatedAt: string;

    it('crea un producto con slug generado sin tildes y único, y lo audita', async () => {
      const body = { name: 'Vestido Floral Año Nuevo', categoryId, brandId, gender: 'women', basePrice: '49.9', compareAtPrice: '59.90', cost: 20 };
      const res = await request(server()).post('/v1/catalog/admin/products').set('Authorization', seller).send(body);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        name: 'Vestido Floral Año Nuevo',
        slug: 'vestido-floral-ano-nuevo',
        status: 'draft',
        publishedAt: null,
        basePrice: '49.90',
        compareAtPrice: '59.90',
        cost: '20.00',
        taxCode: '4',
        brand: { id: brandId },
        category: { id: categoryId, path: 'mujer/vestidos-de-fiesta' },
        variants: [],
        media: [],
      });
      productId = res.body.id;
      updatedAt = res.body.updatedAt;

      const again = await request(server()).post('/v1/catalog/admin/products').set('Authorization', admin).send(body);
      expect(again.status).toBe(201);
      expect(again.body.slug).toBe('vestido-floral-ano-nuevo-2');

      const audit = await auditRows('catalog.product.created', productId);
      expect(audit).toHaveLength(1);
      expect(audit[0].actor_id).toBe(t.userId);
      expect(audit[0].after).toMatchObject({ basePrice: '49.90', slug: 'vestido-floral-ano-nuevo' });
    });

    it('valida precio tachado, slug repetido, referencias de otra tienda e IVA', async () => {
      const base = { name: 'Blusa', categoryId, gender: 'women', basePrice: '20.00' };
      const price = await request(server()).post('/v1/catalog/admin/products').set('Authorization', admin).send({ ...base, compareAtPrice: '20.00' });
      expect(price.status).toBe(422);
      expect(price.body.error.code).toBe('INVALID_PRICE');

      const slug = await request(server()).post('/v1/catalog/admin/products').set('Authorization', admin).send({ ...base, slug: 'vestido-floral-ano-nuevo' });
      expect(slug.status).toBe(409);
      expect(slug.body.error.code).toBe('SLUG_TAKEN');

      const foreign = await request(server()).post('/v1/catalog/admin/products').set('Authorization', admin).send({ ...base, categoryId: otherCategoryId });
      expect(foreign.status).toBe(422);
      expect(foreign.body.error).toMatchObject({ code: 'INVALID_REFERENCE', details: { field: 'categoryId' } });

      const tax = await request(server()).post('/v1/catalog/admin/products').set('Authorization', admin).send({ ...base, taxCode: '99' });
      expect(tax.status).toBe(422);
      expect(tax.body.error.code).toBe('UNKNOWN_TAX_CODE');

      const bad = await request(server()).post('/v1/catalog/admin/products').set('Authorization', admin).send({ ...base, basePrice: '1.999' });
      expect(bad.status).toBe(400);
    });

    it('bodega, soporte y clientes no administran el catálogo (403)', async () => {
      for (const who of [warehouse, support, customer]) {
        expect((await request(server()).get('/v1/catalog/admin/products').set('Authorization', who)).status).toBe(403);
        expect((await request(server()).post('/v1/catalog/admin/products').set('Authorization', who).send({})).status).toBe(403);
      }
      expect((await request(server()).get('/v1/catalog/admin/products')).status).toBe(401);
    });

    it('edita con concurrencia optimista: activar fija publishedAt; un token viejo da 409 STALE_PRODUCT', async () => {
      const res = await request(server())
        .patch(`/v1/catalog/admin/products/${productId}`)
        .set('Authorization', admin)
        .send({ status: 'active', basePrice: '45.00', material: 'Lino', expectedUpdatedAt: updatedAt });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'active', basePrice: '45.00', material: 'Lino' });
      expect(res.body.publishedAt).not.toBeNull();
      expect(res.body.updatedAt).not.toBe(updatedAt);

      const stale = await request(server())
        .patch(`/v1/catalog/admin/products/${productId}`)
        .set('Authorization', seller)
        .send({ name: 'Otro nombre', expectedUpdatedAt: updatedAt });
      expect(stale.status).toBe(409);
      expect(stale.body.error).toMatchObject({ code: 'STALE_PRODUCT', details: { currentUpdatedAt: res.body.updatedAt } });

      const audit = await auditRows('catalog.product.updated', productId);
      expect(audit).toHaveLength(1);
      expect(audit[0].before).toEqual({ basePrice: '49.90', material: null, status: 'draft' });
      expect(audit[0].after).toEqual({ basePrice: '45.00', material: 'Lino', status: 'active' });

      const published = res.body.publishedAt;
      const archived = await request(server())
        .patch(`/v1/catalog/admin/products/${productId}`)
        .set('Authorization', admin)
        .send({ status: 'archived', expectedUpdatedAt: res.body.updatedAt });
      expect(archived.status).toBe(200);
      const back = await request(server())
        .patch(`/v1/catalog/admin/products/${productId}`)
        .set('Authorization', admin)
        .send({ status: 'active', compareAtPrice: null, expectedUpdatedAt: archived.body.updatedAt });
      expect(back.body).toMatchObject({ status: 'active', publishedAt: published, compareAtPrice: null });
      updatedAt = back.body.updatedAt;

      const missing = await request(server())
        .patch(`/v1/catalog/admin/products/${randomUUID()}`)
        .set('Authorization', admin)
        .send({ name: 'Nada', expectedUpdatedAt: updatedAt });
      expect(missing.status).toBe(404);
      const noToken = await request(server()).patch(`/v1/catalog/admin/products/${productId}`).set('Authorization', admin).send({ name: 'Nada' });
      expect(noToken.status).toBe(400);
    });

    describe('variantes', () => {
      let variantId: string;
      const sku = `VF-${tag}-ROJO-S`;
      const barcode = `786${tag.replace(/[^0-9]/g, '0').padEnd(10, '1')}`;

      it('crea variantes y rechaza SKU, código de barras y color+talla repetidos', async () => {
        const res = await request(server())
          .post(`/v1/catalog/admin/products/${productId}/variants`)
          .set('Authorization', admin)
          .send({ sku, barcode, colorId, sizeId: sizeS });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({
          sku,
          barcode,
          color: { id: colorId, name: 'Rojo', hex: '#ff0000' },
          size: { id: sizeS, code: 'S' },
          price: null,
          effectivePrice: '45.00',
          weightG: 300,
          status: 'active',
        });
        variantId = res.body.id;

        const post = (body: Record<string, unknown>) =>
          request(server()).post(`/v1/catalog/admin/products/${productId}/variants`).set('Authorization', admin).send(body);
        expect((await post({ sku, colorId, sizeId: sizeM })).body.error.code).toBe('SKU_TAKEN');
        expect((await post({ sku: `${sku}-B`, barcode, colorId, sizeId: sizeM })).body.error.code).toBe('BARCODE_TAKEN');
        const dup = await post({ sku: `${sku}-C`, colorId, sizeId: sizeS });
        expect(dup.status).toBe(409);
        expect(dup.body.error.code).toBe('VARIANT_DUPLICATE');
        const price = await post({ sku: `${sku}-D`, colorId, sizeId: sizeM, price: '30.00', compareAtPrice: '29.00' });
        expect(price.body.error.code).toBe('INVALID_PRICE');

        const m = await post({ sku: `${sku}-M`, colorId, sizeId: sizeM, price: '47.50', weightG: 350 });
        expect(m.status).toBe(201);
        expect(m.body.effectivePrice).toBe('47.50');

        const forbidden = await request(server())
          .post(`/v1/catalog/admin/products/${productId}/variants`)
          .set('Authorization', warehouse)
          .send({ sku: `${sku}-W` });
        expect(forbidden.status).toBe(403);
      });

      it('edita una variante y la audita', async () => {
        const res = await request(server())
          .patch(`/v1/catalog/admin/variants/${variantId}`)
          .set('Authorization', seller)
          .send({ price: '44.00', compareAtPrice: '50.00', weightG: 320 });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ price: '44.00', compareAtPrice: '50.00', effectivePrice: '44.00', weightG: 320 });
        const audit = await auditRows('catalog.variant.updated', variantId);
        expect(audit[0].before).toEqual({ price: null, compareAtPrice: null, weightG: 300 });

        const back = await request(server()).patch(`/v1/catalog/admin/variants/${variantId}`).set('Authorization', seller).send({ price: null, compareAtPrice: null });
        expect(back.body).toMatchObject({ price: null, effectivePrice: '45.00' });
        expect((await request(server()).patch(`/v1/catalog/admin/variants/${randomUUID()}`).set('Authorization', seller).send({ weightG: 1 })).status).toBe(404);
      });

      it('el detalle trae variantes con precio efectivo y el listado filtra', async () => {
        const detail = await request(server()).get(`/v1/catalog/admin/products/${productId}`).set('Authorization', admin);
        expect(detail.status).toBe(200);
        expect(detail.body.variants.map((v: { sku: string; effectivePrice: string }) => [v.sku, v.effectivePrice])).toEqual([
          [sku, '45.00'],
          [`${sku}-M`, '47.50'],
        ]);
        expect(detail.body.updatedAt).toBe(updatedAt);

        const list = await request(server()).get('/v1/catalog/admin/products').query({ status: 'active', q: 'floral' }).set('Authorization', admin);
        expect(list.status).toBe(200);
        expect(list.body.total).toBe(1);
        expect(list.body.items[0]).toMatchObject({
          id: productId,
          variantCount: 2,
          basePrice: '45.00',
          brand: { id: brandId },
          category: { id: categoryId, path: 'mujer/vestidos-de-fiesta' },
        });
        const bySku = await request(server()).get('/v1/catalog/admin/products').query({ q: `${sku}-M` }).set('Authorization', admin);
        expect(bySku.body.items.map((i: { id: string }) => i.id)).toEqual([productId]);
        const drafts = await request(server()).get('/v1/catalog/admin/products').query({ status: 'draft', limit: 1 }).set('Authorization', admin);
        expect(drafts.body.total).toBe(1);
      });

      it('busca variantes por código de barras exacto o por texto (bodega y vendedor sí; soporte y clientes no)', async () => {
        const scan = await request(server()).get('/v1/catalog/variants/lookup').query({ barcode }).set('Authorization', warehouse);
        expect(scan.status).toBe(200);
        expect(scan.body).toEqual([
          {
            variantId,
            productId,
            sku,
            barcode,
            productName: 'Vestido Floral Año Nuevo',
            color: 'Rojo',
            size: 'S',
            price: '45.00',
            status: 'active',
            productStatus: 'active',
          },
        ]);
        expect((await request(server()).get('/v1/catalog/variants/lookup').query({ barcode: '0000000000' }).set('Authorization', warehouse)).body).toEqual([]);

        const text = await request(server()).get('/v1/catalog/variants/lookup').query({ q: 'vestido floral' }).set('Authorization', seller);
        expect(text.status).toBe(200);
        expect(text.body.map((v: { sku: string }) => v.sku).sort()).toEqual([sku, `${sku}-M`]);
        const exactFirst = await request(server()).get('/v1/catalog/variants/lookup').query({ q: `${sku}-M` }).set('Authorization', seller);
        expect(exactFirst.body[0].sku).toBe(`${sku}-M`);

        // Otro tenant no ve las variantes de este.
        const foreign = await request(server()).get('/v1/catalog/variants/lookup').query({ barcode }).set('Authorization', bearer(other, 'warehouse'));
        expect(foreign.body).toEqual([]);

        expect((await request(server()).get('/v1/catalog/variants/lookup').query({ barcode }).set('Authorization', support)).status).toBe(403);
        expect((await request(server()).get('/v1/catalog/variants/lookup').query({ barcode }).set('Authorization', customer)).status).toBe(403);
        expect((await request(server()).get('/v1/catalog/variants/lookup').set('Authorization', warehouse)).status).toBe(422);
      });

      it('nombra variantes por ids (las del tenant; las ajenas se omiten; máximo 100)', async () => {
        const unknown = '00000000-0000-4000-8000-000000000000';
        const byIds = await request(server())
          .get('/v1/catalog/variants/lookup')
          .query({ ids: `${variantId},${unknown}` })
          .set('Authorization', warehouse);
        expect(byIds.status).toBe(200);
        expect(byIds.body).toEqual([expect.objectContaining({ variantId, productId, sku, barcode, productName: 'Vestido Floral Año Nuevo' })]);

        // Ids repetidos (ids=a&ids=a) no duplican filas.
        const repeated = await request(server()).get(`/v1/catalog/variants/lookup?ids=${variantId}&ids=${variantId}`).set('Authorization', warehouse);
        expect(repeated.body).toHaveLength(1);

        const foreign = await request(server()).get('/v1/catalog/variants/lookup').query({ ids: variantId }).set('Authorization', bearer(other, 'warehouse'));
        expect(foreign.status).toBe(200);
        expect(foreign.body).toEqual([]);

        const tooMany = Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`).join(',');
        expect((await request(server()).get('/v1/catalog/variants/lookup').query({ ids: tooMany }).set('Authorization', warehouse)).status).toBe(400);
        expect((await request(server()).get('/v1/catalog/variants/lookup').query({ ids: 'no-es-uuid' }).set('Authorization', warehouse)).status).toBe(400);
      });

      it('cambia precios en masa en una transacción y revierte todo si un id no existe', async () => {
        const res = await request(server())
          .patch('/v1/catalog/admin/prices')
          .set('Authorization', admin)
          .send({
            products: [{ id: productId, basePrice: '42.00', compareAtPrice: '55.00' }],
            variants: [{ id: variantId, price: '39.99' }],
          });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ products: [productId], variants: [variantId] });
        const audit = await auditRows('catalog.product.price_changed', productId);
        expect(audit[0].before).toEqual({ basePrice: '45.00', compareAtPrice: null });
        expect(audit[0].after).toEqual({ basePrice: '42.00', compareAtPrice: '55.00' });
        expect((await auditRows('catalog.variant.price_changed', variantId))[0].after).toEqual({ price: '39.99', compareAtPrice: null });

        // El producto cambió: el token de concurrencia anterior ya no sirve.
        const stale = await request(server()).patch(`/v1/catalog/admin/products/${productId}`).set('Authorization', admin).send({ name: 'Otro nombre', expectedUpdatedAt: updatedAt });
        expect(stale.body.error.code).toBe('STALE_PRODUCT');

        const ghost = randomUUID();
        const failed = await request(server())
          .patch('/v1/catalog/admin/prices')
          .set('Authorization', admin)
          .send({ products: [{ id: productId, basePrice: '10.00', compareAtPrice: null }], variants: [{ id: ghost, price: '1.00' }] });
        expect(failed.status).toBe(404);
        expect(failed.body.error).toMatchObject({ code: 'VARIANT_NOT_FOUND', details: { id: ghost } });
        const row = await db.query(`SELECT base_price, compare_at_price FROM catalog.products WHERE id = $1`, [productId]);
        expect(row.rows[0]).toEqual({ base_price: '42.00', compare_at_price: '55.00' });

        const invalid = await request(server()).patch('/v1/catalog/admin/prices').set('Authorization', admin).send({ products: [{ id: productId, basePrice: '60.00' }] });
        expect(invalid.status).toBe(422);
        expect(invalid.body.error.code).toBe('INVALID_PRICE');

        const tooMany = Array.from({ length: 201 }, () => ({ id: randomUUID(), price: '1.00' }));
        expect((await request(server()).patch('/v1/catalog/admin/prices').set('Authorization', admin).send({ variants: tooMany })).status).toBe(400);
        const mixed = { products: Array.from({ length: 100 }, () => ({ id: randomUUID() })), variants: Array.from({ length: 101 }, () => ({ id: randomUUID() })) };
        const mixedRes = await request(server()).patch('/v1/catalog/admin/prices').set('Authorization', admin).send(mixed);
        expect(mixedRes.body.error.code).toBe('TOO_MANY_ROWS');
        expect((await request(server()).patch('/v1/catalog/admin/prices').set('Authorization', warehouse).send({ products: [] })).status).toBe(403);
      });

      it('sube una foto (magic bytes), la sirve y la quita', async () => {
        const up = await request(server())
          .post(`/v1/catalog/admin/products/${productId}/media`)
          .set('Authorization', admin)
          .field('colorId', colorId)
          .field('altText', 'Vestido rojo de frente')
          .attach('file', PNG, { filename: 'foto.png', contentType: 'image/png' });
        expect(up.status).toBe(201);
        expect(up.body).toMatchObject({ colorId, sortOrder: 0, altText: 'Vestido rojo de frente' });
        expect(up.body.url).toMatch(new RegExp(`^/media/products/${t.tenantId}/${productId}/[0-9a-f-]{36}\\.png$`));

        const file = up.body.url.replace(/^\/media\//, '');
        const served = await request(server()).get(`/v1/catalog/media/${file}`);
        expect(served.status).toBe(200);
        expect(served.headers['content-type']).toBe('image/png');

        const fake = await request(server())
          .post(`/v1/catalog/admin/products/${productId}/media`)
          .set('Authorization', admin)
          .attach('file', Buffer.from('<html>no</html>'), { filename: 'x.png', contentType: 'image/png' });
        expect(fake.status).toBe(422);
        expect(fake.body.error.code).toBe('MEDIA_TYPE');

        const detail = await request(server()).get(`/v1/catalog/admin/products/${productId}`).set('Authorization', admin);
        expect(detail.body.media).toEqual([up.body]);

        // Edición de la foto existente: color, texto alternativo y orden.
        const patchMedia = (who: string, body: Record<string, unknown>, id = up.body.id) =>
          request(server()).patch(`/v1/catalog/admin/media/${id}`).set('Authorization', who).send(body);
        const edited = await patchMedia(seller, { colorId: null, altText: 'Vista trasera', sortOrder: 3 });
        expect(edited.status).toBe(200);
        expect(edited.body).toEqual({ id: up.body.id, url: up.body.url, colorId: null, altText: 'Vista trasera', sortOrder: 3 });
        const partial = await patchMedia(admin, { colorId, altText: null });
        expect(partial.body).toMatchObject({ colorId, altText: null, sortOrder: 3 });
        expect((await patchMedia(admin, { colorId: randomUUID() })).body.error.code).toBe('INVALID_REFERENCE');
        expect((await patchMedia(admin, { sortOrder: -1 })).status).toBe(400);
        expect((await patchMedia(admin, { altText: 'x'.repeat(201) })).status).toBe(400);
        expect((await patchMedia(admin, { sortOrder: 1 }, randomUUID())).status).toBe(404);
        expect((await patchMedia(warehouse, { sortOrder: 1 })).status).toBe(403);
        expect((await request(server()).get(`/v1/catalog/admin/products/${productId}`).set('Authorization', admin)).body.media[0]).toEqual(partial.body);
        const mediaAudit = await auditRows('catalog.media.updated', up.body.id);
        expect(mediaAudit.length).toBeGreaterThanOrEqual(2);

        expect((await request(server()).delete(`/v1/catalog/admin/media/${up.body.id}`).set('Authorization', admin)).status).toBe(200);
        expect((await request(server()).delete(`/v1/catalog/admin/media/${up.body.id}`).set('Authorization', admin)).status).toBe(404);
      });
    });
  });

  describe('variantes que heredan el precio del producto', () => {
    let productId: string;
    let heirId: string;
    let ownId: string;

    const product = async () => (await request(server()).get(`/v1/catalog/admin/products/${productId}`).set('Authorization', admin)).body;

    beforeAll(async () => {
      const p = await request(server())
        .post('/v1/catalog/admin/products')
        .set('Authorization', admin)
        .send({ name: `Chaqueta heredera ${tag}`, categoryId, gender: 'men', basePrice: '40.00' });
      productId = p.body.id;
      const heir = await request(server())
        .post(`/v1/catalog/admin/products/${productId}/variants`)
        .set('Authorization', admin)
        .send({ sku: `CH-${tag}-S`, sizeId: sizeS, compareAtPrice: '50.00' });
      const own = await request(server())
        .post(`/v1/catalog/admin/products/${productId}/variants`)
        .set('Authorization', admin)
        .send({ sku: `CH-${tag}-M`, sizeId: sizeM, price: '30.00', compareAtPrice: '35.00' });
      expect([heir.status, own.status]).toEqual([201, 201]);
      heirId = heir.body.id;
      ownId = own.body.id;
    });

    it('PATCH del producto: subir el base por encima del tachado de una heredera da 422 y no cambia nada', async () => {
      const before = await product();
      const res = await request(server())
        .patch(`/v1/catalog/admin/products/${productId}`)
        .set('Authorization', admin)
        .send({ basePrice: '55.00', expectedUpdatedAt: before.updatedAt });
      expect(res.status).toBe(422);
      expect(res.body.error).toMatchObject({ code: 'INVALID_PRICE', details: { variantIds: [heirId] } });
      const after = await product();
      expect(after.basePrice).toBe('40.00');
      expect(after.updatedAt).toBe(before.updatedAt);
      expect(await auditRows('catalog.product.updated', productId)).toHaveLength(0);

      // Subir sin pasar el tachado de la heredera sí se puede (la de precio propio no se ve afectada).
      const ok = await request(server())
        .patch(`/v1/catalog/admin/products/${productId}`)
        .set('Authorization', admin)
        .send({ basePrice: '49.99', expectedUpdatedAt: before.updatedAt });
      expect(ok.status).toBe(200);
    });

    it('precios masivos: 422 si la heredera no viene; OK si viene con su tachado corregido', async () => {
      const failed = await request(server())
        .patch('/v1/catalog/admin/prices')
        .set('Authorization', admin)
        .send({ products: [{ id: productId, basePrice: '60.00' }] });
      expect(failed.status).toBe(422);
      expect(failed.body.error).toMatchObject({ code: 'INVALID_PRICE', details: { productId, variantIds: [heirId] } });
      expect((await product()).basePrice).toBe('49.99');

      const ok = await request(server())
        .patch('/v1/catalog/admin/prices')
        .set('Authorization', admin)
        .send({ products: [{ id: productId, basePrice: '60.00' }], variants: [{ id: heirId, compareAtPrice: '70.00' }] });
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ products: [productId], variants: [heirId] });
      const p = await product();
      expect(p.basePrice).toBe('60.00');
      expect(p.variants.find((v: { id: string }) => v.id === heirId)).toMatchObject({ price: null, compareAtPrice: '70.00', effectivePrice: '60.00' });
      expect(p.variants.find((v: { id: string }) => v.id === ownId)).toMatchObject({ price: '30.00', compareAtPrice: '35.00' });

      // Quitar el tachado de la heredera también la deja válida.
      const cleared = await request(server())
        .patch('/v1/catalog/admin/prices')
        .set('Authorization', admin)
        .send({ products: [{ id: productId, basePrice: '80.00' }], variants: [{ id: heirId, compareAtPrice: null }] });
      expect(cleared.status).toBe(200);
    });
  });
});
