import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Database, Queryable } from '../../libs/shared-kernel';
import { createTenant, createWarehouse, setStock, TestTenant } from '../support/fixtures';
import { createTestApp } from '../support/test-app';

interface ProductSpec {
  slug: string;
  name: string;
  category: string;
  brand: string;
  gender?: string;
  price: string;
  compareAt?: string;
  description?: string;
  status?: string;
  publishedAt?: string;
  /** [color, talla, precio propio?] */
  variants: Array<[string, string, string?]>;
  ratingAvg?: string;
}

/** Catálogo pequeño pero con todo lo que filtra la tienda: marcas, colores, tallas, rebajas, borradores. */
async function seedCatalog(db: Queryable, tenantId: string, warehouseId: string) {
  const ids: Record<string, string> = {};
  const one = async (sql: string, params: unknown[]) => (await db.query<{ id: string }>(sql, params)).rows[0].id;

  for (const [path, name] of [
    ['mujer', 'Mujer'],
    ['mujer/vestidos', 'Vestidos'],
    ['hombre', 'Hombre'],
    ['hombre/jeans', 'Jeans'],
  ]) {
    ids[`cat:${path}`] = await one(`INSERT INTO catalog.categories (tenant_id, name, slug, path) VALUES ($1, $2, $3, $4) RETURNING id`, [
      tenantId,
      name,
      path.split('/').pop(),
      path,
    ]);
  }
  for (const [slug, name] of [
    ['andina', 'Andina'],
    ['pacifico', 'Pacífico'],
  ]) {
    ids[`brand:${slug}`] = await one(`INSERT INTO catalog.brands (tenant_id, name, slug) VALUES ($1, $2, $3) RETURNING id`, [tenantId, name, slug]);
  }
  for (const [name, hex] of [
    ['Negro', '#000000'],
    ['Rojo', '#C0392B'],
    ['Azul', '#1F4E9C'],
  ]) {
    ids[`color:${name}`] = await one(`INSERT INTO catalog.colors (tenant_id, name, hex) VALUES ($1, $2, $3) RETURNING id`, [tenantId, name, hex]);
  }
  for (const [i, code] of ['S', 'M', 'L'].entries()) {
    ids[`size:${code}`] = await one(`INSERT INTO catalog.sizes (tenant_id, code, size_system, sort_order) VALUES ($1, $2, 'alpha', $3) RETURNING id`, [
      tenantId,
      code,
      i,
    ]);
  }
  for (const [i, code] of ['30', '32'].entries()) {
    ids[`size:${code}`] = await one(`INSERT INTO catalog.sizes (tenant_id, code, size_system, sort_order) VALUES ($1, $2, 'numeric', $3) RETURNING id`, [
      tenantId,
      code,
      i,
    ]);
  }
  const chart = await one(`INSERT INTO catalog.size_charts (tenant_id, name, data) VALUES ($1, 'Vestidos', $2) RETURNING id`, [
    tenantId,
    JSON.stringify({ unit: 'cm', columns: ['Talla', 'Busto'], rows: [['S', '84-88'], ['M', '89-93']] }),
  ]);

  const products: ProductSpec[] = [
    {
      slug: 'vestido-midi-lino',
      name: 'Vestido midi de lino',
      category: 'mujer/vestidos',
      brand: 'andina',
      gender: 'women',
      price: '49.90',
      compareAt: '69.90',
      description: 'Vestido fresco para la costa',
      variants: [['Rojo', 'S'], ['Rojo', 'M'], ['Negro', 'M'], ['Negro', 'L', '54.90']],
      ratingAvg: '4.50',
    },
    {
      slug: 'vestido-camisero',
      name: 'Vestido camisero',
      category: 'mujer/vestidos',
      brand: 'pacifico',
      gender: 'women',
      price: '39.00',
      variants: [['Azul', 'S'], ['Azul', 'M']],
      ratingAvg: '3.90',
    },
    { slug: 'jean-slim', name: 'Jean slim', category: 'hombre/jeans', brand: 'pacifico', gender: 'men', price: '45.00', variants: [['Azul', '30'], ['Negro', '32']] },
    { slug: 'jean-borrador', name: 'Jean en borrador', category: 'hombre/jeans', brand: 'pacifico', gender: 'men', price: '10.00', status: 'draft', variants: [['Azul', '30']] },
    {
      slug: 'jean-futuro',
      name: 'Jean de la próxima temporada',
      category: 'hombre/jeans',
      brand: 'andina',
      gender: 'men',
      price: '12.00',
      publishedAt: '2099-01-01T00:00:00Z',
      variants: [['Negro', '30']],
    },
  ];

  for (const [i, p] of products.entries()) {
    const productId = await one(
      `INSERT INTO catalog.products (tenant_id, brand_id, category_id, size_chart_id, name, slug, description, gender, base_price,
                                     compare_at_price, status, published_at, rating_avg, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now() - make_interval(mins => $14)) RETURNING id`,
      [
        tenantId,
        ids[`brand:${p.brand}`],
        ids[`cat:${p.category}`],
        p.category === 'mujer/vestidos' ? chart : null,
        p.name,
        p.slug,
        p.description ?? null,
        p.gender ?? 'unisex',
        p.price,
        p.compareAt ?? null,
        p.status ?? 'active',
        p.publishedAt ?? null,
        p.ratingAvg ?? '0',
        // El primero de la lista es el más nuevo.
        i,
      ],
    );
    ids[`product:${p.slug}`] = productId;
    for (const [color, size, price] of p.variants) {
      const variantId = await one(
        `INSERT INTO catalog.product_variants (product_id, sku, color_id, size_id, price) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [productId, `${p.slug}-${color}-${size}-${tenantId.slice(0, 6)}`, ids[`color:${color}`], ids[`size:${size}`], price ?? null],
      );
      ids[`variant:${p.slug}:${color}:${size}`] = variantId;
    }
    await db.query(
      `INSERT INTO catalog.product_media (product_id, color_id, media_type, storage_key, alt_text, sort_order)
       VALUES ($1, NULL, 'image', $2, $3, 0), ($1, $4, 'image', $5, $6, 1)`,
      [productId, `demo/${p.slug}-1.svg`, p.name, ids[`color:${p.variants[0][0]}`], `demo/${p.slug}-2.svg`, `${p.name} ${p.variants[0][0]}`],
    );
  }

  // Stock: el vestido midi tiene M rojo agotado y L negro con pocas unidades; el camisero está agotado.
  await setStock(db, ids['variant:vestido-midi-lino:Rojo:S'], warehouseId, 10);
  await setStock(db, ids['variant:vestido-midi-lino:Rojo:M'], warehouseId, 0);
  await setStock(db, ids['variant:vestido-midi-lino:Negro:L'], warehouseId, 2);
  await setStock(db, ids['variant:jean-slim:Azul:30'], warehouseId, 5);
  return ids;
}

describe('Catálogo público del storefront (integración)', () => {
  let app: INestApplication;
  let db: Database;
  let t: TestTenant;
  let other: TestTenant;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
    t = await createTenant(db);
    other = await createTenant(db);
    const warehouse = await createWarehouse(db, t.tenantId);
    await seedCatalog(db, t.tenantId, warehouse);
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (path: string, tenantId = t.tenantId) => request(app.getHttpServer()).get(`/v1/catalog${path}`).set('X-Tenant-Id', tenantId);
  const slugs = (body: { items: Array<{ slug: string }> }) => body.items.map((i) => i.slug);

  it('lista solo lo publicado, del tenant del header, con precio, rebaja, fotos y disponibilidad', async () => {
    const res = await get('/products').expect(200);
    expect(res.headers['cache-control']).toContain('public');
    expect(res.body.total).toBe(3);
    expect(slugs(res.body)).toEqual(['vestido-midi-lino', 'vestido-camisero', 'jean-slim']);

    const midi = res.body.items[0];
    expect(midi).toMatchObject({
      name: 'Vestido midi de lino',
      brand: { name: 'Andina', slug: 'andina' },
      price: '49.90',
      compareAtPrice: '69.90',
      ratingAvg: '4.50',
      available: true,
    });
    expect(midi.images[0].url).toBe('/media/demo/vestido-midi-lino-1.svg');
    expect(midi.colors.map((c: { name: string }) => c.name)).toEqual(['Negro', 'Rojo']);
    expect(midi).not.toHaveProperty('variantIds');
    expect(res.body.items[1]).toMatchObject({ slug: 'vestido-camisero', available: false });

    // Otro tenant no ve nada; sin header, 400.
    expect((await get('/products', other.tenantId).expect(200)).body.total).toBe(0);
    await request(app.getHttpServer()).get('/v1/catalog/products').expect(400);
  });

  it('filtra por categoría (con subcategorías), talla, color, precio y marca', async () => {
    expect(slugs((await get('/products?category=mujer').expect(200)).body)).toEqual(['vestido-midi-lino', 'vestido-camisero']);
    expect(slugs((await get('/products?category=hombre/jeans').expect(200)).body)).toEqual(['jean-slim']);
    expect(slugs((await get('/products?size=L,30').expect(200)).body)).toEqual(['vestido-midi-lino', 'jean-slim']);
    expect(slugs((await get('/products?color=azul').expect(200)).body)).toEqual(['vestido-camisero', 'jean-slim']);
    expect(slugs((await get('/products?brand=pacifico&gender=women').expect(200)).body)).toEqual(['vestido-camisero']);
    expect(slugs((await get('/products?minPrice=40&maxPrice=46').expect(200)).body)).toEqual(['jean-slim']);
    expect(slugs((await get('/products?onSale=true').expect(200)).body)).toEqual(['vestido-midi-lino']);

    // Talla y color sobre la MISMA variante: no hay vestido midi rojo en L.
    expect(slugs((await get('/products?color=Rojo&size=L').expect(200)).body)).toEqual([]);
    // El precio mostrado es el de la variante más barata que cumple el filtro.
    const onlyL = (await get('/products?size=L').expect(200)).body.items[0];
    expect(onlyL.price).toBe('54.90');
  });

  it('facetas disyuntivas: cada una cuenta ignorando su propio filtro', async () => {
    const { facets } = (await get('/products?color=Azul').expect(200)).body;
    // El filtro de color no reduce la faceta de color.
    expect(facets.colors).toEqual([
      { value: 'Azul', label: 'Azul', hex: '#1F4E9C', count: 2 },
      { value: 'Negro', label: 'Negro', hex: '#000000', count: 2 },
      { value: 'Rojo', label: 'Rojo', hex: '#C0392B', count: 1 },
    ]);
    // Pero sí reduce las demás.
    expect(facets.brands).toEqual([{ value: 'pacifico', label: 'Pacífico', count: 2 }]);
    expect(facets.sizes.map((s: { value: string }) => s.value)).toEqual(['S', 'M', '30']);
    expect(facets.genders).toEqual([
      { value: 'men', label: 'Hombre', count: 1 },
      { value: 'women', label: 'Mujer', count: 1 },
    ]);
    expect(facets.price).toEqual({ min: '39.00', max: '45.00' });
  });

  it('ordena y pagina', async () => {
    expect(slugs((await get('/products?sort=price_asc').expect(200)).body)).toEqual(['vestido-camisero', 'jean-slim', 'vestido-midi-lino']);
    expect(slugs((await get('/products?sort=price_desc').expect(200)).body)).toEqual(['vestido-midi-lino', 'jean-slim', 'vestido-camisero']);
    expect(slugs((await get('/products?sort=rating').expect(200)).body)[0]).toBe('vestido-midi-lino');
    const page2 = (await get('/products?pageSize=2&page=2').expect(200)).body;
    expect(page2).toMatchObject({ total: 3, page: 2, pageSize: 2 });
    expect(slugs(page2)).toEqual(['jean-slim']);
    await get('/products?pageSize=500').expect(400);
    await get('/products?sort=barato').expect(400);
  });

  it('busca por texto en español, con errores de tipeo y por marca', async () => {
    expect(slugs((await get('/products?q=vestidos').expect(200)).body)).toEqual(expect.arrayContaining(['vestido-midi-lino', 'vestido-camisero']));
    expect(slugs((await get('/products?q=costa').expect(200)).body)).toEqual(['vestido-midi-lino']);
    expect(slugs((await get('/products?q=camisro').expect(200)).body)).toEqual(['vestido-camisero']);
    expect(slugs((await get('/products?q=pac%C3%ADfico').expect(200)).body)).toEqual(expect.arrayContaining(['vestido-camisero', 'jean-slim']));
    // Los comodines de LIKE se buscan literalmente.
    expect((await get('/products?q=%25%25').expect(200)).body.total).toBe(0);

    const suggest = (await get('/search/suggest?q=vest').expect(200)).body;
    expect(suggest.products.map((p: { slug: string }) => p.slug)).toEqual(expect.arrayContaining(['vestido-midi-lino', 'vestido-camisero']));
    expect(suggest.products[0].imageUrl).toMatch(/^\/media\/demo\//);
    expect(suggest.categories).toEqual([{ name: 'Vestidos', slug: 'vestidos', path: 'mujer/vestidos' }]);
    await get('/search/suggest?q=v').expect(400);
  });

  it('ficha de producto con galería, variantes con stock por nivel, guía de tallas, migas y relacionados', async () => {
    const res = await get('/products/vestido-midi-lino').expect(200);
    const p = res.body;
    expect(p).toMatchObject({
      name: 'Vestido midi de lino',
      gender: 'women',
      price: '49.90',
      compareAtPrice: '69.90',
      category: { path: 'mujer/vestidos' },
      sizeChart: { name: 'Vestidos', data: { unit: 'cm' } },
    });
    expect(p.breadcrumb.map((c: { path: string }) => c.path)).toEqual(['mujer', 'mujer/vestidos']);
    expect(p.media).toHaveLength(2);
    expect(p.media[1]).toMatchObject({ colorName: 'Rojo', url: '/media/demo/vestido-midi-lino-2.svg' });
    expect(p.colors.map((c: { name: string }) => c.name)).toEqual(['Negro', 'Rojo']);
    expect(p.sizes).toEqual(['S', 'M', 'L']);
    const stock = Object.fromEntries(p.variants.map((v: { color: { name: string }; size: string; stock: string }) => [`${v.color.name}-${v.size}`, v.stock]));
    expect(stock).toEqual({ 'Rojo-S': 'in_stock', 'Rojo-M': 'out_of_stock', 'Negro-M': 'out_of_stock', 'Negro-L': 'low' });
    expect(p.variants.find((v: { size: string }) => v.size === 'L').price).toBe('54.90');
    expect(p.related.map((r: { slug: string }) => r.slug)).toEqual(['vestido-camisero']);
    expect(JSON.stringify(p)).not.toMatch(/"cost"|unit_cost/);

    await get('/products/jean-borrador').expect(404);
    await get('/products/jean-futuro').expect(404);
    await get('/products/vestido-midi-lino', other.tenantId).expect(404);
    await get('/products/NO_VALIDO').expect(400);
  });

  it('miniaturas por id para el carrito: solo productos publicados, con todas sus fotos', async () => {
    const all = (await get('/products').expect(200)).body.items as Array<{ id: string; slug: string }>;
    const midi = all.find((p) => p.slug === 'vestido-midi-lino')!;
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM catalog.products WHERE tenant_id = $1 AND slug = 'jean-borrador'`, [t.tenantId]);
    const res = await get(`/product-thumbs?ids=${midi.id},${rows[0].id}`).expect(200);
    expect(res.body).toEqual([
      {
        id: midi.id,
        slug: 'vestido-midi-lino',
        name: 'Vestido midi de lino',
        images: [expect.objectContaining({ url: '/media/demo/vestido-midi-lino-1.svg' }), expect.objectContaining({ colorName: 'Rojo' })],
      },
    ]);
    await get('/product-thumbs?ids=no-es-uuid').expect(400);
    await get('/product-thumbs').expect(400);
  });

  it('categorías con conteos, marcas, colecciones y sitemap', async () => {
    const cats = (await get('/categories').expect(200)).body;
    expect(cats.map((c: { path: string; productCount: number; parentPath: string | null }) => [c.path, c.productCount, c.parentPath])).toEqual([
      ['hombre', 1, null],
      ['hombre/jeans', 1, 'hombre'],
      ['mujer', 2, null],
      ['mujer/vestidos', 2, 'mujer'],
    ]);
    expect((await get('/brands').expect(200)).body).toEqual([
      { name: 'Andina', slug: 'andina', logoUrl: null, productCount: 1 },
      { name: 'Pacífico', slug: 'pacifico', logoUrl: null, productCount: 2 },
    ]);
    expect((await get('/collections').expect(200)).body).toEqual([]);

    const sitemap = (await get('/sitemap').expect(200)).body as Array<{ type: string; key: string }>;
    expect(sitemap.filter((e) => e.type === 'product').map((e) => e.key).sort()).toEqual(['jean-slim', 'vestido-camisero', 'vestido-midi-lino']);
    expect(sitemap.filter((e) => e.type === 'category')).toHaveLength(4);
  });
});
