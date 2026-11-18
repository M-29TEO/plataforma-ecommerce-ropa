-- =====================================================================
-- Entregable 3 — Modelo de datos (PostgreSQL 16 + PostGIS)
-- Plataforma e-commerce de moda · Ecuador · stack open source
--
-- Convenciones:
--  - PK uuid (gen_random_uuid()); tablas append-only de alto volumen con bigint identity.
--  - Dinero numeric(12,2) + currency char(3), por defecto USD.
--  - timestamptz en UTC; presentación en America/Guayaquil.
--  - Snapshots en pedidos, ítems y facturas (el histórico no cambia si cambia el catálogo).
--  - tenant_id en agregados raíz; RLS preparado (ver final del archivo).
--  - Borrado lógico / anonimización por LOPDP; documentos SRI se conservan 7 años.
--  - Concurrencia optimista con columna version.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE SCHEMA iam; CREATE SCHEMA catalog; CREATE SCHEMA inventory;
CREATE SCHEMA sales; CREATE SCHEMA payments; CREATE SCHEMA billing;
CREATE SCHEMA logistics; CREATE SCHEMA crm; CREATE SCHEMA support;
CREATE SCHEMA platform;

-- =====================================================================
-- IAM
-- =====================================================================
CREATE TABLE iam.tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  ruc         varchar(13),
  settings    jsonb NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE iam.users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES iam.tenants(id),
  user_type         text NOT NULL CHECK (user_type IN ('customer','staff','rider')),
  email             citext NOT NULL,
  phone             varchar(20),
  password_hash     text,                      -- argon2id
  first_name        text,
  last_name         text,
  id_type           char(2) CHECK (id_type IN ('04','05','06')), -- SRI: RUC, cédula, pasaporte
  id_number         varchar(20),
  locale            varchar(5) NOT NULL DEFAULT 'es-EC',
  mfa_enabled       boolean NOT NULL DEFAULT false,
  mfa_secret_enc    bytea,                     -- TOTP cifrado con libsodium
  status            text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('pending','active','blocked','anonymized')),
  email_verified_at timestamptz,
  last_login_at     timestamptz,
  failed_logins     smallint NOT NULL DEFAULT 0,
  locked_until      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  UNIQUE (tenant_id, email)
);
CREATE INDEX ix_users_phone ON iam.users (tenant_id, phone);
CREATE INDEX ix_users_idnum ON iam.users (tenant_id, id_number);

CREATE TABLE iam.user_identities (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES iam.users(id) ON DELETE CASCADE,
  provider     text NOT NULL,
  provider_uid text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_uid)
);

CREATE TABLE iam.refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES iam.users(id) ON DELETE CASCADE,
  family_id   uuid NOT NULL,
  token_hash  bytea NOT NULL UNIQUE,
  user_agent  text,
  ip          inet,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_rt_user ON iam.refresh_tokens (user_id) WHERE revoked_at IS NULL;

CREATE TABLE iam.roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES iam.tenants(id),
  code        text NOT NULL,
  name        text NOT NULL,
  is_system   boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, code)
);

CREATE TABLE iam.permissions (
  code        text PRIMARY KEY,     -- 'catalog.product.write', 'orders.refund'
  description text NOT NULL
);

CREATE TABLE iam.role_permissions (
  role_id         uuid REFERENCES iam.roles(id) ON DELETE CASCADE,
  permission_code text REFERENCES iam.permissions(code),
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE iam.user_roles (
  user_id     uuid REFERENCES iam.users(id) ON DELETE CASCADE,
  role_id     uuid REFERENCES iam.roles(id) ON DELETE CASCADE,
  scope       jsonb NOT NULL DEFAULT '{}',
  granted_by  uuid REFERENCES iam.users(id),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE iam.api_clients (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES iam.tenants(id),
  name         text NOT NULL,
  client_id    text NOT NULL UNIQUE,
  secret_hash  text NOT NULL,
  scopes       text[] NOT NULL DEFAULT '{}',
  ip_allowlist cidr[],
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE iam.consents (                   -- LOPDP
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     uuid REFERENCES iam.users(id),
  guest_email citext,
  purpose     text NOT NULL CHECK (purpose IN ('terms','privacy','marketing_email',
                     'marketing_whatsapp','marketing_sms','profiling','cookies_analytics')),
  policy_version text NOT NULL,
  granted     boolean NOT NULL,
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_consents_user ON iam.consents (user_id, purpose, created_at DESC);

-- =====================================================================
-- CATÁLOGO
-- =====================================================================
CREATE TABLE catalog.brands (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES iam.tenants(id),
  name      text NOT NULL,
  slug      text NOT NULL,
  logo_url  text,
  active    boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, slug)
);

CREATE TABLE catalog.categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES iam.tenants(id),
  parent_id  uuid REFERENCES catalog.categories(id),
  name       text NOT NULL,
  slug       text NOT NULL,
  path       text NOT NULL,            -- 'mujer/vestidos/casual'
  sort_order int NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, path)
);
CREATE INDEX ix_categories_path ON catalog.categories (tenant_id, path text_pattern_ops);

CREATE TABLE catalog.collections (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES iam.tenants(id),
  name      text NOT NULL,
  slug      text NOT NULL,
  starts_at timestamptz,
  ends_at   timestamptz,
  UNIQUE (tenant_id, slug)
);

CREATE TABLE catalog.size_charts (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES iam.tenants(id),
  name      text NOT NULL,
  data      jsonb NOT NULL
);

CREATE TABLE catalog.colors (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES iam.tenants(id),
  name      text NOT NULL,
  hex       char(7),
  family    text,
  UNIQUE (tenant_id, name)
);

CREATE TABLE catalog.sizes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES iam.tenants(id),
  code        text NOT NULL,
  size_system text NOT NULL DEFAULT 'alpha' CHECK (size_system IN ('alpha','numeric','shoe','kids')),
  sort_order  int NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, size_system, code)
);

CREATE TABLE catalog.products (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES iam.tenants(id),
  brand_id         uuid REFERENCES catalog.brands(id),
  category_id      uuid NOT NULL REFERENCES catalog.categories(id),
  size_chart_id    uuid REFERENCES catalog.size_charts(id),
  name             text NOT NULL,
  slug             text NOT NULL,
  description      text,
  gender           text NOT NULL CHECK (gender IN ('women','men','unisex','girls','boys','baby')),
  season           text,
  material         text,
  care_instructions text,
  base_price       numeric(12,2) NOT NULL CHECK (base_price >= 0),
  compare_at_price numeric(12,2),
  cost             numeric(12,2),
  tax_code         varchar(4) NOT NULL DEFAULT '4',  -- código porcentaje IVA SRI (4 = 15%)
  attributes       jsonb NOT NULL DEFAULT '{}',
  seo              jsonb NOT NULL DEFAULT '{}',
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  published_at     timestamptz,
  search_vector    tsvector GENERATED ALWAYS AS (
                     setweight(to_tsvector('spanish', coalesce(name,'')), 'A') ||
                     setweight(to_tsvector('spanish', coalesce(material,'')), 'B') ||
                     setweight(to_tsvector('spanish', coalesce(description,'')), 'C')
                   ) STORED,
  rating_avg       numeric(3,2) NOT NULL DEFAULT 0,
  rating_count     int NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  UNIQUE (tenant_id, slug)
);
CREATE INDEX ix_products_search ON catalog.products USING gin (search_vector);
CREATE INDEX ix_products_name_trgm ON catalog.products USING gin (name gin_trgm_ops);
CREATE INDEX ix_products_listing ON catalog.products (tenant_id, category_id, status, published_at DESC);
CREATE INDEX ix_products_attrs ON catalog.products USING gin (attributes jsonb_path_ops);

CREATE TABLE catalog.product_translations (
  product_id  uuid REFERENCES catalog.products(id) ON DELETE CASCADE,
  locale      varchar(5),
  name        text NOT NULL,
  description text,
  seo         jsonb,
  PRIMARY KEY (product_id, locale)
);

CREATE TABLE catalog.product_collections (
  product_id    uuid REFERENCES catalog.products(id) ON DELETE CASCADE,
  collection_id uuid REFERENCES catalog.collections(id) ON DELETE CASCADE,
  sort_order    int NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, product_id)
);

CREATE TABLE catalog.product_variants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid NOT NULL REFERENCES catalog.products(id) ON DELETE CASCADE,
  sku         text NOT NULL,
  barcode     text,
  color_id    uuid REFERENCES catalog.colors(id),
  size_id     uuid REFERENCES catalog.sizes(id),
  price       numeric(12,2),
  compare_at_price numeric(12,2),
  weight_g    int NOT NULL DEFAULT 300,
  length_mm   int, width_mm int, height_mm int,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sku),
  UNIQUE (product_id, color_id, size_id)
);
CREATE UNIQUE INDEX ux_variants_barcode ON catalog.product_variants (barcode) WHERE barcode IS NOT NULL;
CREATE INDEX ix_variants_facets ON catalog.product_variants (color_id, size_id) WHERE status = 'active';

CREATE TABLE catalog.product_media (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid NOT NULL REFERENCES catalog.products(id) ON DELETE CASCADE,
  color_id    uuid REFERENCES catalog.colors(id),
  media_type  text NOT NULL CHECK (media_type IN ('image','video','spin360','ar_model')),
  storage_key text NOT NULL,                 -- clave en SeaweedFS (API S3)
  alt_text    text,
  width int, height int,
  sort_order  int NOT NULL DEFAULT 0
);
CREATE INDEX ix_media_product ON catalog.product_media (product_id, color_id, sort_order);

CREATE TABLE catalog.reviews (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    uuid NOT NULL REFERENCES catalog.products(id),
  user_id       uuid NOT NULL REFERENCES iam.users(id),
  order_item_id uuid,
  rating        smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  fit_feedback  text CHECK (fit_feedback IN ('small','true','large')),
  title         text,
  body          text,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  helpful_count int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, product_id, order_item_id)
);
CREATE INDEX ix_reviews_product ON catalog.reviews (product_id, status, created_at DESC);

CREATE TABLE catalog.review_media (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id   uuid NOT NULL REFERENCES catalog.reviews(id) ON DELETE CASCADE,
  storage_key text NOT NULL
);

CREATE TABLE catalog.product_questions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES catalog.products(id),
  user_id    uuid REFERENCES iam.users(id),
  body       text NOT NULL,
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published','rejected')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_questions_product ON catalog.product_questions (product_id, status);

CREATE TABLE catalog.product_answers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id uuid NOT NULL REFERENCES catalog.product_questions(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES iam.users(id),
  is_official boolean NOT NULL DEFAULT false,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- INVENTARIO
-- =====================================================================
CREATE TABLE inventory.warehouses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES iam.tenants(id),
  code            text NOT NULL,
  name            text NOT NULL,
  type            text NOT NULL CHECK (type IN ('warehouse','store','dark_store')),
  address         jsonb NOT NULL,
  location        geography(Point, 4326) NOT NULL,
  city            text NOT NULL,
  is_pickup_point boolean NOT NULL DEFAULT false,
  ships_online    boolean NOT NULL DEFAULT true,
  active          boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code)
);
CREATE INDEX ix_wh_location ON inventory.warehouses USING gist (location);

CREATE TABLE inventory.stock_levels (
  variant_id    uuid NOT NULL REFERENCES catalog.product_variants(id),
  warehouse_id  uuid NOT NULL REFERENCES inventory.warehouses(id),
  on_hand       int NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved      int NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  available     int GENERATED ALWAYS AS (on_hand - reserved) STORED,
  reorder_point int NOT NULL DEFAULT 3,
  reorder_qty   int NOT NULL DEFAULT 12,
  bin_location  text,
  version       int NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (variant_id, warehouse_id),
  CHECK (reserved <= on_hand)
);
CREATE INDEX ix_stock_low ON inventory.stock_levels (warehouse_id)
  WHERE on_hand - reserved <= reorder_point;

CREATE TABLE inventory.stock_movements (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  variant_id     uuid NOT NULL REFERENCES catalog.product_variants(id),
  warehouse_id   uuid NOT NULL REFERENCES inventory.warehouses(id),
  quantity       int NOT NULL,
  movement_type  text NOT NULL CHECK (movement_type IN ('purchase','sale','return','adjustment',
                     'transfer_in','transfer_out','damage','count')),
  reference_type text,
  reference_id   uuid,
  unit_cost      numeric(12,2),
  reason         text,
  user_id        uuid REFERENCES iam.users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_movements_variant ON inventory.stock_movements (variant_id, warehouse_id, created_at DESC);
CREATE INDEX ix_movements_ref ON inventory.stock_movements (reference_type, reference_id);

CREATE TABLE inventory.stock_reservations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id   uuid NOT NULL REFERENCES catalog.product_variants(id),
  warehouse_id uuid NOT NULL REFERENCES inventory.warehouses(id),
  order_id     uuid NOT NULL,
  quantity     int NOT NULL CHECK (quantity > 0),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','consumed','released')),
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_resv_expiring ON inventory.stock_reservations (expires_at) WHERE status = 'active';
CREATE INDEX ix_resv_order ON inventory.stock_reservations (order_id);

CREATE TABLE inventory.suppliers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES iam.tenants(id),
  name       text NOT NULL,
  ruc        varchar(13),
  contact    jsonb NOT NULL DEFAULT '{}',
  lead_time_days int,
  active     boolean NOT NULL DEFAULT true
);

CREATE TABLE inventory.purchase_orders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES iam.tenants(id),
  supplier_id  uuid NOT NULL REFERENCES inventory.suppliers(id),
  warehouse_id uuid NOT NULL REFERENCES inventory.warehouses(id),
  number       text NOT NULL,
  status       text NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','sent','partially_received','received','cancelled')),
  expected_at  date,
  total        numeric(12,2) NOT NULL DEFAULT 0,
  created_by   uuid REFERENCES iam.users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);

CREATE TABLE inventory.purchase_order_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id uuid NOT NULL REFERENCES inventory.purchase_orders(id) ON DELETE CASCADE,
  variant_id        uuid NOT NULL REFERENCES catalog.product_variants(id),
  qty_ordered       int NOT NULL CHECK (qty_ordered > 0),
  qty_received      int NOT NULL DEFAULT 0,
  unit_cost         numeric(12,2) NOT NULL
);

-- =====================================================================
-- VENTAS
-- =====================================================================
CREATE TABLE sales.carts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES iam.tenants(id),
  user_id          uuid REFERENCES iam.users(id),
  guest_token_hash bytea,
  contact_email    citext,
  contact_phone    varchar(20),
  currency         char(3) NOT NULL DEFAULT 'USD',
  coupon_codes     text[] NOT NULL DEFAULT '{}',
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','converted','abandoned','merged')),
  reminders_sent   smallint NOT NULL DEFAULT 0,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_cart_user_active ON sales.carts (user_id) WHERE status = 'active';
CREATE INDEX ix_cart_abandoned ON sales.carts (last_activity_at)
  WHERE status = 'active' AND (contact_email IS NOT NULL OR contact_phone IS NOT NULL);

CREATE TABLE sales.cart_items (
  cart_id      uuid REFERENCES sales.carts(id) ON DELETE CASCADE,
  variant_id   uuid REFERENCES catalog.product_variants(id),
  quantity     int NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  price_at_add numeric(12,2) NOT NULL,
  added_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cart_id, variant_id)
);

CREATE TABLE sales.promotions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES iam.tenants(id),
  name        text NOT NULL,
  type        text NOT NULL CHECK (type IN ('percent','fixed','buy_x_get_y','free_shipping','tiered','gift')),
  conditions  jsonb NOT NULL DEFAULT '{}',
  benefit     jsonb NOT NULL,
  requires_coupon boolean NOT NULL DEFAULT false,
  stackable   boolean NOT NULL DEFAULT false,
  priority    int NOT NULL DEFAULT 100,
  max_uses    int,
  used_count  int NOT NULL DEFAULT 0,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_promos_active ON sales.promotions (tenant_id, starts_at, ends_at) WHERE active;

CREATE TABLE sales.coupons (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id          uuid NOT NULL REFERENCES sales.promotions(id) ON DELETE CASCADE,
  tenant_id             uuid NOT NULL REFERENCES iam.tenants(id),
  code                  citext NOT NULL,
  max_uses              int,
  max_uses_per_customer int NOT NULL DEFAULT 1,
  used_count            int NOT NULL DEFAULT 0,
  assigned_user_id      uuid REFERENCES iam.users(id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE sales.promotion_redemptions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  promotion_id uuid NOT NULL REFERENCES sales.promotions(id),
  coupon_id    uuid REFERENCES sales.coupons(id),
  order_id     uuid NOT NULL,
  user_id      uuid REFERENCES iam.users(id),
  customer_key text NOT NULL,
  discount     numeric(12,2) NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_redemptions_customer ON sales.promotion_redemptions (coupon_id, customer_key);

CREATE TABLE sales.gift_cards (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES iam.tenants(id),
  code_hash       bytea NOT NULL UNIQUE,
  last4           char(4) NOT NULL,
  initial_amount  numeric(12,2) NOT NULL,
  balance         numeric(12,2) NOT NULL CHECK (balance >= 0),
  currency        char(3) NOT NULL DEFAULT 'USD',
  purchaser_id    uuid REFERENCES iam.users(id),
  recipient_email citext,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','depleted','expired','blocked')),
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sales.gift_card_transactions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  gift_card_id uuid NOT NULL REFERENCES sales.gift_cards(id),
  order_id     uuid,
  amount       numeric(12,2) NOT NULL,
  type         text NOT NULL CHECK (type IN ('issue','redeem','refund','adjust','expire')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE sales.order_number_seq START 100001;

CREATE TABLE sales.orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES iam.tenants(id),
  order_number        bigint NOT NULL DEFAULT nextval('sales.order_number_seq'),
  user_id             uuid REFERENCES iam.users(id),
  cart_id             uuid,
  customer            jsonb NOT NULL,
  billing             jsonb NOT NULL,
  status              text NOT NULL DEFAULT 'created' CHECK (status IN
                        ('created','paid','preparing','shipped','in_transit',
                         'delivered','cancelled','returned','partially_returned')),
  payment_status      text NOT NULL DEFAULT 'pending' CHECK (payment_status IN
                        ('pending','authorized','paid','cod_pending','partially_refunded','refunded','failed')),
  payment_method      text NOT NULL,
  fulfillment_type    text NOT NULL CHECK (fulfillment_type IN ('rider','courier','pickup')),
  shipping_address    jsonb,
  shipping_location   geography(Point, 4326),
  shipping_city       text,
  shipping_zone_id    uuid,
  delivery_slot_id    uuid,
  source_warehouse_id uuid REFERENCES inventory.warehouses(id),
  currency            char(3) NOT NULL DEFAULT 'USD',
  exchange_rate       numeric(12,6) NOT NULL DEFAULT 1,
  subtotal            numeric(12,2) NOT NULL,
  discount_total      numeric(12,2) NOT NULL DEFAULT 0,
  shipping_total      numeric(12,2) NOT NULL DEFAULT 0,
  tax_total           numeric(12,2) NOT NULL DEFAULT 0,
  gift_card_total     numeric(12,2) NOT NULL DEFAULT 0,
  total               numeric(12,2) NOT NULL,
  cost_total          numeric(12,2),
  channel             text NOT NULL DEFAULT 'web' CHECK (channel IN ('web','app','whatsapp','backoffice','store')),
  seller_id           uuid REFERENCES iam.users(id),
  utm                 jsonb,
  notes               text,
  cancel_reason       text,
  placed_at           timestamptz NOT NULL DEFAULT now(),
  paid_at             timestamptz,
  shipped_at          timestamptz,
  delivered_at        timestamptz,
  cancelled_at        timestamptz,
  version             int NOT NULL DEFAULT 0,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, order_number)
);
CREATE INDEX ix_orders_user ON sales.orders (user_id, placed_at DESC);
CREATE INDEX ix_orders_status ON sales.orders (tenant_id, status, placed_at DESC);
CREATE INDEX ix_orders_placed_brin ON sales.orders USING brin (placed_at);
CREATE INDEX ix_orders_email ON sales.orders ((customer->>'email'));
CREATE INDEX ix_orders_cod ON sales.orders (tenant_id) WHERE payment_status = 'cod_pending';

CREATE TABLE sales.order_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL REFERENCES sales.orders(id) ON DELETE CASCADE,
  variant_id      uuid NOT NULL REFERENCES catalog.product_variants(id),
  product_id      uuid NOT NULL,
  sku             text NOT NULL,
  product_name    text NOT NULL,
  brand_name      text,
  category_path   text,
  color_name      text,
  size_code       text,
  quantity        int NOT NULL CHECK (quantity > 0),
  unit_price      numeric(12,2) NOT NULL,
  discount        numeric(12,2) NOT NULL DEFAULT 0,
  tax_code        varchar(4) NOT NULL,
  tax_rate        numeric(5,2) NOT NULL,
  tax_amount      numeric(12,2) NOT NULL,
  line_total      numeric(12,2) NOT NULL,
  unit_cost       numeric(12,2),
  warehouse_id    uuid REFERENCES inventory.warehouses(id),
  qty_returned    int NOT NULL DEFAULT 0
);
CREATE INDEX ix_oi_order ON sales.order_items (order_id);
CREATE INDEX ix_oi_variant ON sales.order_items (variant_id);

CREATE TABLE sales.order_status_history (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id    uuid NOT NULL REFERENCES sales.orders(id) ON DELETE CASCADE,
  from_status text,
  to_status   text NOT NULL,
  actor_type  text NOT NULL CHECK (actor_type IN ('customer','staff','rider','system','courier')),
  actor_id    uuid,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_osh_order ON sales.order_status_history (order_id, created_at);

CREATE TABLE sales.returns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES iam.tenants(id),
  order_id        uuid NOT NULL REFERENCES sales.orders(id),
  rma_number      text NOT NULL,
  type            text NOT NULL CHECK (type IN ('return','exchange')),
  status          text NOT NULL DEFAULT 'requested' CHECK (status IN
                    ('requested','approved','rejected','pickup_scheduled','received',
                     'inspected','refunded','exchanged','closed')),
  resolution      text CHECK (resolution IN ('refund_original','store_credit','exchange')),
  reason          text NOT NULL,
  customer_notes  text,
  refund_amount   numeric(12,2),
  return_shipping_paid_by text CHECK (return_shipping_paid_by IN ('customer','store')),
  approved_by     uuid REFERENCES iam.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  UNIQUE (tenant_id, rma_number)
);
CREATE INDEX ix_returns_order ON sales.returns (order_id);
CREATE INDEX ix_returns_status ON sales.returns (tenant_id, status);

CREATE TABLE sales.return_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id           uuid NOT NULL REFERENCES sales.returns(id) ON DELETE CASCADE,
  order_item_id       uuid NOT NULL REFERENCES sales.order_items(id),
  quantity            int NOT NULL CHECK (quantity > 0),
  reason_code         text NOT NULL CHECK (reason_code IN ('size_small','size_large','defect',
                        'not_as_described','wrong_item','changed_mind','other')),
  condition           text CHECK (condition IN ('new','used','damaged')),
  restock             boolean,
  exchange_variant_id uuid REFERENCES catalog.product_variants(id),
  photos              text[] NOT NULL DEFAULT '{}'
);

-- =====================================================================
-- PAGOS (nunca PAN ni CVV; solo tokens del proveedor)
-- =====================================================================
CREATE TABLE payments.payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES iam.tenants(id),
  order_id        uuid NOT NULL,
  method          text NOT NULL CHECK (method IN ('card','deuna','pichincha','transfer','qr','cod','gift_card')),
  provider        text NOT NULL CHECK (provider IN ('simulator','datafast','payphone','medianet',
                     'deuna','pichincha','manual','internal')),
  amount          numeric(12,2) NOT NULL CHECK (amount > 0),
  currency        char(3) NOT NULL DEFAULT 'USD',
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN
                    ('pending','requires_action','authorized','captured','failed',
                     'cancelled','expired','refunded','partially_refunded')),
  provider_ref    text,
  authorization_code text,
  installments    smallint,
  installment_type text,
  card_brand      text,
  card_last4      char(4),
  idempotency_key text NOT NULL,
  failure_code    text,
  failure_message text,
  fee_amount      numeric(12,2),
  expires_at      timestamptz,
  captured_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX ix_pay_order ON payments.payments (order_id);
CREATE UNIQUE INDEX ux_pay_provider_ref ON payments.payments (provider, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX ix_pay_pending ON payments.payments (status, expires_at) WHERE status IN ('pending','requires_action');

CREATE TABLE payments.payment_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_id  uuid NOT NULL REFERENCES payments.payments(id),
  event_type  text NOT NULL,
  payload     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_pe_payment ON payments.payment_events (payment_id, created_at);

CREATE TABLE payments.webhook_inbox (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider        text NOT NULL,
  external_id     text NOT NULL,
  payload         jsonb NOT NULL,
  signature_valid boolean NOT NULL,          -- verificación HMAC
  processed_at    timestamptz,
  error           text,
  received_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id)
);

CREATE TABLE payments.refunds (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id   uuid NOT NULL REFERENCES payments.payments(id),
  return_id    uuid,
  amount       numeric(12,2) NOT NULL CHECK (amount > 0),
  method       text NOT NULL CHECK (method IN ('original','transfer','store_credit','gift_card')),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','succeeded','failed')),
  provider_ref text,
  reason       text,
  requested_by uuid REFERENCES iam.users(id),
  approved_by  uuid REFERENCES iam.users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE payments.customer_payment_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES iam.users(id) ON DELETE CASCADE,
  provider   text NOT NULL,
  token_enc  bytea NOT NULL,                  -- cifrado con libsodium
  brand      text, last4 char(4),
  exp_month  smallint, exp_year smallint,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payments.bank_transfers (
  payment_id  uuid PRIMARY KEY REFERENCES payments.payments(id),
  bank_name   text NOT NULL,
  reference   text,
  voucher_key text,
  verified_by uuid REFERENCES iam.users(id),
  verified_at timestamptz,
  rejection_reason text
);

CREATE TABLE payments.provider_settlements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES iam.tenants(id),
  provider        text NOT NULL,
  settlement_date date NOT NULL,
  gross           numeric(12,2) NOT NULL,
  fees            numeric(12,2) NOT NULL,
  withholdings    numeric(12,2) NOT NULL DEFAULT 0,
  net             numeric(12,2) NOT NULL,
  file_key        text,
  status          text NOT NULL DEFAULT 'imported' CHECK (status IN ('imported','reconciled','discrepancy')),
  UNIQUE (tenant_id, provider, settlement_date)
);

CREATE TABLE payments.settlement_lines (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  settlement_id uuid NOT NULL REFERENCES payments.provider_settlements(id) ON DELETE CASCADE,
  provider_ref  text NOT NULL,
  payment_id    uuid REFERENCES payments.payments(id),
  amount        numeric(12,2) NOT NULL,
  fee           numeric(12,2) NOT NULL DEFAULT 0,
  match_status  text NOT NULL DEFAULT 'unmatched' CHECK (match_status IN ('matched','unmatched','amount_mismatch'))
);

-- =====================================================================
-- FACTURACIÓN ELECTRÓNICA SRI
-- =====================================================================
CREATE TABLE billing.emission_points (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES iam.tenants(id),
  establishment  char(3) NOT NULL,
  emission_point char(3) NOT NULL,
  address        text NOT NULL,
  environment    smallint NOT NULL CHECK (environment IN (1,2)),  -- 1 pruebas, 2 producción
  active         boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, establishment, emission_point)
);

CREATE TABLE billing.sequences (
  emission_point_id uuid REFERENCES billing.emission_points(id),
  doc_type          char(2) NOT NULL CHECK (doc_type IN ('01','04','05','06','07')),
  last_value        bigint NOT NULL DEFAULT 0 CHECK (last_value < 1000000000),
  PRIMARY KEY (emission_point_id, doc_type)
);

CREATE TABLE billing.electronic_documents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES iam.tenants(id),
  doc_type            char(2) NOT NULL,           -- 01 factura, 04 nota de crédito
  emission_point_id   uuid NOT NULL REFERENCES billing.emission_points(id),
  sequential          bigint NOT NULL,
  access_key          char(49) NOT NULL UNIQUE,   -- dígito verificador módulo 11
  environment         smallint NOT NULL,
  issue_date          date NOT NULL,
  order_id            uuid,
  return_id           uuid,
  modified_document_id uuid REFERENCES billing.electronic_documents(id),
  buyer_id_type       char(2) NOT NULL,           -- 04 RUC, 05 cédula, 06 pasaporte, 07 consumidor final
  buyer_id            varchar(20) NOT NULL,
  buyer_name          text NOT NULL,
  buyer_email         citext,
  buyer_address       text,
  subtotal_0          numeric(12,2) NOT NULL DEFAULT 0,
  subtotal_taxed      numeric(12,2) NOT NULL DEFAULT 0,
  discount_total      numeric(12,2) NOT NULL DEFAULT 0,
  tax_total           numeric(12,2) NOT NULL DEFAULT 0,
  total               numeric(12,2) NOT NULL,
  payment_forms       jsonb NOT NULL,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN
                        ('pending','signed','sent','received','authorized',
                         'returned','not_authorized','voided')),
  authorization_number text,
  authorized_at       timestamptz,
  xml_key             text,
  ride_key            text,
  sri_messages        jsonb,
  attempts            smallint NOT NULL DEFAULT 0,
  next_retry_at       timestamptz,
  emailed_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (emission_point_id, doc_type, sequential)
);
CREATE INDEX ix_ed_order ON billing.electronic_documents (order_id);
CREATE INDEX ix_ed_retry ON billing.electronic_documents (next_retry_at)
  WHERE status IN ('pending','signed','sent','received');
CREATE INDEX ix_ed_buyer ON billing.electronic_documents (tenant_id, buyer_id);

CREATE TABLE billing.electronic_document_lines (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id  uuid NOT NULL REFERENCES billing.electronic_documents(id) ON DELETE CASCADE,
  main_code    text NOT NULL,
  aux_code     text,
  description  text NOT NULL,
  quantity     numeric(12,4) NOT NULL,
  unit_price   numeric(14,6) NOT NULL,
  discount     numeric(12,2) NOT NULL DEFAULT 0,
  tax_code     char(1) NOT NULL DEFAULT '2',
  tax_rate_code varchar(4) NOT NULL,
  tax_rate     numeric(5,2) NOT NULL,
  tax_base     numeric(12,2) NOT NULL,
  tax_amount   numeric(12,2) NOT NULL,
  line_total   numeric(12,2) NOT NULL
);

-- =====================================================================
-- LOGÍSTICA
-- =====================================================================
CREATE TABLE logistics.coverage_zones (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES iam.tenants(id),
  name                    text NOT NULL,
  city                    text NOT NULL,
  area                    geography(MultiPolygon, 4326) NOT NULL,
  delivery_mode           text NOT NULL CHECK (delivery_mode IN ('rider','courier','both')),
  priority                int NOT NULL DEFAULT 100,
  base_fee                numeric(12,2) NOT NULL,
  fee_per_km              numeric(12,2) NOT NULL DEFAULT 0,
  fee_per_extra_kg        numeric(12,2) NOT NULL DEFAULT 0,
  max_weight_kg           numeric(6,2) NOT NULL DEFAULT 15,
  free_shipping_threshold numeric(12,2),
  same_day_cutoff         time,
  serving_warehouse_id    uuid REFERENCES inventory.warehouses(id),
  active                  boolean NOT NULL DEFAULT true
);
CREATE INDEX ix_zones_area ON logistics.coverage_zones USING gist (area);

CREATE TABLE logistics.delivery_slot_templates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id    uuid NOT NULL REFERENCES logistics.coverage_zones(id) ON DELETE CASCADE,
  weekday    smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time time NOT NULL,
  end_time   time NOT NULL,
  capacity   int NOT NULL,
  surcharge  numeric(12,2) NOT NULL DEFAULT 0
);

CREATE TABLE logistics.delivery_slots (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id   uuid NOT NULL REFERENCES logistics.coverage_zones(id),
  slot_date date NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at   timestamptz NOT NULL,
  capacity  int NOT NULL,
  booked    int NOT NULL DEFAULT 0 CHECK (booked >= 0),
  cutoff_at timestamptz NOT NULL,
  surcharge numeric(12,2) NOT NULL DEFAULT 0,
  UNIQUE (zone_id, starts_at),
  CHECK (booked <= capacity)
);
CREATE INDEX ix_slots_lookup ON logistics.delivery_slots (zone_id, slot_date);

CREATE TABLE logistics.riders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL UNIQUE REFERENCES iam.users(id),
  tenant_id        uuid NOT NULL REFERENCES iam.tenants(id),
  vehicle_type     text NOT NULL CHECK (vehicle_type IN ('motorcycle','bicycle','car','van')),
  plate            varchar(10),
  license_expiry   date,
  max_load_kg      numeric(6,2) NOT NULL DEFAULT 20,
  max_concurrent   smallint NOT NULL DEFAULT 3,
  home_zone_id     uuid REFERENCES logistics.coverage_zones(id),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('onboarding','active','suspended','inactive')),
  presence         text NOT NULL DEFAULT 'offline' CHECK (presence IN ('offline','available','busy','break')),
  commission_scheme jsonb NOT NULL DEFAULT '{"per_delivery":2.50,"per_km":0.30}',
  cod_limit        numeric(12,2) NOT NULL DEFAULT 200,
  cod_balance      numeric(12,2) NOT NULL DEFAULT 0,
  rating_avg       numeric(3,2) NOT NULL DEFAULT 5,
  rating_count     int NOT NULL DEFAULT 0,
  ntfy_topic       text UNIQUE,                 -- tópico privado de ntfy para ofertas de pedidos
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_riders_presence ON logistics.riders (tenant_id, presence) WHERE status = 'active';

CREATE TABLE logistics.rider_shifts (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id  uuid NOT NULL REFERENCES logistics.riders(id),
  zone_id   uuid REFERENCES logistics.coverage_zones(id),
  starts_at timestamptz NOT NULL,
  ends_at   timestamptz NOT NULL,
  status    text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','active','completed','no_show')),
  checked_in_at timestamptz
);
CREATE INDEX ix_shifts_time ON logistics.rider_shifts (rider_id, starts_at);

-- Posición actual en Valkey GEO; aquí solo el histórico, particionado por mes (retención 90 días).
CREATE TABLE logistics.rider_location_history (
  rider_id    uuid NOT NULL,
  recorded_at timestamptz NOT NULL,
  location    geography(Point, 4326) NOT NULL,
  speed_kmh   real,
  heading     smallint,
  accuracy_m  real,
  shipment_id uuid
) PARTITION BY RANGE (recorded_at);
CREATE TABLE logistics.rider_location_history_2026_10 PARTITION OF logistics.rider_location_history
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE INDEX ix_rlh ON logistics.rider_location_history (rider_id, recorded_at DESC);

CREATE TABLE logistics.couriers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES iam.tenants(id),
  code            text NOT NULL,                 -- 'simulador', 'servientrega'
  name            text NOT NULL,
  adapter         text NOT NULL,
  secret_ref      text NOT NULL,                 -- ruta del secreto en SOPS/OpenBao
  supports_cod    boolean NOT NULL DEFAULT false,
  supports_pickup boolean NOT NULL DEFAULT true,
  tracking_mode   text NOT NULL DEFAULT 'poll' CHECK (tracking_mode IN ('webhook','poll')),
  active          boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code)
);

CREATE TABLE logistics.courier_services (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  courier_id   uuid NOT NULL REFERENCES logistics.couriers(id),
  code         text NOT NULL,
  name         text NOT NULL,
  max_weight_kg numeric(6,2),
  sla_hours    int,
  active       boolean NOT NULL DEFAULT true,
  UNIQUE (courier_id, code)
);

CREATE TABLE logistics.courier_rate_cards (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  courier_service_id uuid NOT NULL REFERENCES logistics.courier_services(id),
  origin_city        text NOT NULL,
  dest_province      text NOT NULL,
  dest_city          text,
  weight_from_kg     numeric(6,2) NOT NULL,
  weight_to_kg       numeric(6,2) NOT NULL,
  price              numeric(12,2) NOT NULL,
  extra_kg_price     numeric(12,2) NOT NULL DEFAULT 0,
  valid_from         date NOT NULL,
  valid_to           date
);
CREATE INDEX ix_rate_lookup ON logistics.courier_rate_cards (courier_service_id, origin_city, dest_province, dest_city);

CREATE TABLE logistics.shipments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES iam.tenants(id),
  order_id             uuid NOT NULL,
  return_id            uuid,
  direction            text NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound','return','exchange')),
  carrier_type         text NOT NULL CHECK (carrier_type IN ('rider','courier','pickup')),
  rider_id             uuid REFERENCES logistics.riders(id),
  courier_service_id   uuid REFERENCES logistics.courier_services(id),
  tracking_number      text,
  tracking_token       text NOT NULL UNIQUE,
  label_key            text,
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN
                         ('pending','ready_for_pickup','assigned','accepted','picked_up',
                          'in_transit','arriving','delivered','failed_attempt',
                          'returned_to_origin','cancelled')),
  origin_warehouse_id  uuid REFERENCES inventory.warehouses(id),
  destination          jsonb NOT NULL,
  destination_location geography(Point, 4326),
  zone_id              uuid REFERENCES logistics.coverage_zones(id),
  delivery_slot_id     uuid REFERENCES logistics.delivery_slots(id),
  distance_m           int,
  weight_g             int NOT NULL,
  volume_cm3           int,
  packages             smallint NOT NULL DEFAULT 1,
  price_charged        numeric(12,2) NOT NULL DEFAULT 0,
  carrier_cost         numeric(12,2),
  cod_amount           numeric(12,2) NOT NULL DEFAULT 0,
  cod_collected        numeric(12,2),
  cod_method           text CHECK (cod_method IN ('cash','card_pos','deuna_qr')),
  otp_hash             bytea,
  attempts             smallint NOT NULL DEFAULT 0,
  eta                  timestamptz,
  assigned_at          timestamptz,
  picked_up_at         timestamptz,
  delivered_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  version              int NOT NULL DEFAULT 0
);
CREATE INDEX ix_ship_order ON logistics.shipments (order_id);
CREATE INDEX ix_ship_rider_active ON logistics.shipments (rider_id)
  WHERE status IN ('assigned','accepted','picked_up','in_transit','arriving');
CREATE INDEX ix_ship_pending ON logistics.shipments (tenant_id, zone_id, created_at) WHERE status = 'pending';
CREATE UNIQUE INDEX ux_ship_tracking ON logistics.shipments (courier_service_id, tracking_number)
  WHERE tracking_number IS NOT NULL;

CREATE TABLE logistics.shipment_items (
  shipment_id   uuid REFERENCES logistics.shipments(id) ON DELETE CASCADE,
  order_item_id uuid NOT NULL,
  quantity      int NOT NULL,
  PRIMARY KEY (shipment_id, order_item_id)
);

CREATE TABLE logistics.courier_quotes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_group_id     uuid NOT NULL,
  shipment_id        uuid REFERENCES logistics.shipments(id),
  courier_service_id uuid NOT NULL REFERENCES logistics.courier_services(id),
  price              numeric(12,2) NOT NULL,
  eta_hours          int,
  source             text NOT NULL CHECK (source IN ('api','rate_card')),
  raw_response       jsonb,
  selected           boolean NOT NULL DEFAULT false,
  valid_until        timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_quotes_group ON logistics.courier_quotes (quote_group_id);

CREATE TABLE logistics.shipment_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shipment_id uuid NOT NULL REFERENCES logistics.shipments(id),
  status      text NOT NULL,
  raw_status  text,
  description text,
  location    geography(Point, 4326),
  source      text NOT NULL CHECK (source IN ('rider_app','courier_webhook','courier_poll','system','staff')),
  occurred_at timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shipment_id, status, occurred_at)
);
CREATE INDEX ix_se_shipment ON logistics.shipment_events (shipment_id, occurred_at);

CREATE TABLE logistics.dispatch_offers (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shipment_id uuid NOT NULL REFERENCES logistics.shipments(id),
  rider_id    uuid NOT NULL REFERENCES logistics.riders(id),
  score       numeric(8,4) NOT NULL,
  score_breakdown jsonb,
  offered_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  response    text CHECK (response IN ('accepted','rejected','expired','cancelled')),
  responded_at timestamptz,
  reject_reason text
);
CREATE INDEX ix_offers_shipment ON logistics.dispatch_offers (shipment_id, offered_at);
CREATE INDEX ix_offers_rider_open ON logistics.dispatch_offers (rider_id) WHERE response IS NULL;

CREATE TABLE logistics.delivery_proofs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id   uuid NOT NULL REFERENCES logistics.shipments(id),
  proof_type    text NOT NULL CHECK (proof_type IN ('photo','signature','otp','id_check')),
  storage_key   text,
  otp_verified  boolean,
  receiver_name text,
  location      geography(Point, 4326) NOT NULL,
  distance_to_destination_m int,
  captured_at   timestamptz NOT NULL
);
CREATE INDEX ix_pod_shipment ON logistics.delivery_proofs (shipment_id);

CREATE TABLE logistics.ratings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL REFERENCES logistics.shipments(id),
  rater_type  text NOT NULL CHECK (rater_type IN ('customer','rider')),
  rater_id    uuid NOT NULL,
  ratee_id    uuid NOT NULL,
  score       smallint NOT NULL CHECK (score BETWEEN 1 AND 5),
  tags        text[] NOT NULL DEFAULT '{}',
  comment     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shipment_id, rater_type)
);

CREATE TABLE logistics.rider_settlements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id         uuid NOT NULL REFERENCES logistics.riders(id),
  period_start     date NOT NULL,
  period_end       date NOT NULL,
  deliveries_count int NOT NULL,
  gross_fees       numeric(12,2) NOT NULL,
  bonuses          numeric(12,2) NOT NULL DEFAULT 0,
  deductions       numeric(12,2) NOT NULL DEFAULT 0,
  cod_collected    numeric(12,2) NOT NULL DEFAULT 0,
  cod_remitted     numeric(12,2) NOT NULL DEFAULT 0,
  net_payable      numeric(12,2) NOT NULL,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','paid','disputed')),
  approved_by      uuid REFERENCES iam.users(id),
  paid_at          timestamptz,
  UNIQUE (rider_id, period_start, period_end)
);

CREATE TABLE logistics.rider_settlement_items (
  settlement_id uuid REFERENCES logistics.rider_settlements(id) ON DELETE CASCADE,
  shipment_id   uuid NOT NULL UNIQUE REFERENCES logistics.shipments(id),
  fee           numeric(12,2) NOT NULL,
  cod_amount    numeric(12,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (settlement_id, shipment_id)
);

-- =====================================================================
-- CRM Y FIDELIZACIÓN
-- =====================================================================
CREATE TABLE crm.customer_profiles (
  user_id          uuid PRIMARY KEY REFERENCES iam.users(id) ON DELETE CASCADE,
  birthdate        date,
  gender           text,
  size_preferences jsonb NOT NULL DEFAULT '{}',
  style_tags       text[] NOT NULL DEFAULT '{}',
  referral_code    text UNIQUE,
  orders_count     int NOT NULL DEFAULT 0,
  lifetime_value   numeric(12,2) NOT NULL DEFAULT 0,
  last_order_at    timestamptz,
  risk_score       smallint,
  cod_blocked      boolean NOT NULL DEFAULT false
);

CREATE TABLE crm.addresses (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES iam.users(id) ON DELETE CASCADE,
  label            text,
  recipient_name   text NOT NULL,
  recipient_phone  varchar(20) NOT NULL,
  province         text NOT NULL,
  city             text NOT NULL,
  parish           text,
  neighborhood     text,
  main_street      text NOT NULL,
  cross_street     text,
  house_number     text,
  reference        text,
  location         geography(Point, 4326),     -- geocodificado con Nominatim o pin del usuario
  geocode_accuracy text CHECK (geocode_accuracy IN ('rooftop','street','approximate','user_pin')),
  is_default       boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_addr_user ON crm.addresses (user_id);
CREATE INDEX ix_addr_location ON crm.addresses USING gist (location);

CREATE TABLE crm.wishlist_items (
  user_id    uuid REFERENCES iam.users(id) ON DELETE CASCADE,
  product_id uuid REFERENCES catalog.products(id) ON DELETE CASCADE,
  variant_id uuid REFERENCES catalog.product_variants(id),
  notify_back_in_stock boolean NOT NULL DEFAULT true,
  notify_price_drop    boolean NOT NULL DEFAULT true,
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, product_id)
);

CREATE TABLE crm.loyalty_tiers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES iam.tenants(id),
  name        text NOT NULL,
  min_points  int NOT NULL,
  multiplier  numeric(4,2) NOT NULL DEFAULT 1,
  benefits    jsonb NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, min_points)
);

CREATE TABLE crm.loyalty_accounts (
  user_id         uuid PRIMARY KEY REFERENCES iam.users(id) ON DELETE CASCADE,
  tier_id         uuid REFERENCES crm.loyalty_tiers(id),
  points_balance  int NOT NULL DEFAULT 0 CHECK (points_balance >= 0),
  points_pending  int NOT NULL DEFAULT 0,
  lifetime_points int NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE crm.loyalty_transactions (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES crm.loyalty_accounts(user_id),
  type       text NOT NULL CHECK (type IN ('earn','redeem','expire','adjust','referral','reversal')),
  points     int NOT NULL,
  order_id   uuid,
  status     text NOT NULL DEFAULT 'posted' CHECK (status IN ('pending','posted','cancelled')),
  available_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_lt_user ON crm.loyalty_transactions (user_id, created_at DESC);
CREATE INDEX ix_lt_expiring ON crm.loyalty_transactions (expires_at) WHERE type = 'earn' AND status = 'posted';

CREATE TABLE crm.referrals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id      uuid NOT NULL REFERENCES iam.users(id),
  referee_id       uuid NOT NULL UNIQUE REFERENCES iam.users(id),
  status           text NOT NULL DEFAULT 'registered' CHECK (status IN ('registered','qualified','rewarded','rejected')),
  qualifying_order uuid,
  rewarded_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (referrer_id <> referee_id)
);

-- =====================================================================
-- SOPORTE
-- =====================================================================
CREATE TABLE support.tickets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES iam.tenants(id),
  number       bigint GENERATED ALWAYS AS IDENTITY,
  requester_id uuid REFERENCES iam.users(id),
  requester_contact jsonb,
  order_id     uuid,
  shipment_id  uuid,
  channel      text NOT NULL CHECK (channel IN ('web','whatsapp','email','phone','chat','internal')),
  category     text NOT NULL CHECK (category IN ('order_status','delivery','payment','return',
                  'product','invoice','account','complaint','other')),
  priority     text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending_customer','in_progress','resolved','closed')),
  subject      text NOT NULL,
  assigned_to  uuid REFERENCES iam.users(id),
  sla_due_at   timestamptz,
  first_response_at timestamptz,
  resolved_at  timestamptz,
  csat         smallint CHECK (csat BETWEEN 1 AND 5),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);
CREATE INDEX ix_tickets_queue ON support.tickets (tenant_id, status, priority, sla_due_at);
CREATE INDEX ix_tickets_order ON support.tickets (order_id);

CREATE TABLE support.ticket_messages (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id   uuid NOT NULL REFERENCES support.tickets(id) ON DELETE CASCADE,
  author_type text NOT NULL CHECK (author_type IN ('customer','staff','system','bot')),
  author_id   uuid,
  is_internal boolean NOT NULL DEFAULT false,
  body        text NOT NULL,
  attachments text[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_tm_ticket ON support.ticket_messages (ticket_id, created_at);

-- =====================================================================
-- PLATAFORMA (transversal)
-- =====================================================================
CREATE TABLE platform.outbox_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id      uuid NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id   uuid NOT NULL,
  event_type     text NOT NULL,
  event_version  smallint NOT NULL DEFAULT 1,
  payload        jsonb NOT NULL,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  attempts       smallint NOT NULL DEFAULT 0
);
CREATE INDEX ix_outbox_unpublished ON platform.outbox_events (id) WHERE published_at IS NULL;

CREATE TABLE platform.idempotency_keys (
  key           text NOT NULL,
  scope         text NOT NULL,
  user_ref      text NOT NULL,
  request_hash  bytea NOT NULL,
  response_code smallint,
  response_body jsonb,
  locked_until  timestamptz,
  expires_at    timestamptz NOT NULL,
  PRIMARY KEY (scope, user_ref, key)
);
CREATE INDEX ix_idem_expiry ON platform.idempotency_keys (expires_at);

CREATE TABLE platform.audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id   uuid NOT NULL,
  actor_id    uuid,
  actor_type  text NOT NULL,
  actor_ip    inet,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text NOT NULL,
  before      jsonb,
  after       jsonb,
  request_id  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE TABLE platform.audit_log_2026_10 PARTITION OF platform.audit_log
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE INDEX ix_audit_entity ON platform.audit_log (entity_type, entity_id, created_at DESC);
CREATE INDEX ix_audit_actor ON platform.audit_log (actor_id, created_at DESC);
-- El rol de la app solo tiene INSERT y SELECT sobre audit_log.
-- Migración 0015: trigger tr_audit_log_append_only rechaza UPDATE/DELETE/TRUNCATE (también al dueño).

CREATE TABLE platform.notification_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES iam.tenants(id),
  code            text NOT NULL,
  channel         text NOT NULL CHECK (channel IN ('email','webpush','ntfy','whatsapp','sms')),
  locale          varchar(5) NOT NULL DEFAULT 'es-EC',
  subject         text,
  body            text NOT NULL,
  provider_template text,
  category        text NOT NULL CHECK (category IN ('transactional','marketing')),
  active          boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code, channel, locale)
);

CREATE TABLE platform.notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  user_id       uuid,
  channel       text NOT NULL,
  template_code text NOT NULL,
  recipient     text NOT NULL,
  payload       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','delivered','read','failed','suppressed')),
  provider_msg_id text,
  error         text,
  dedupe_key    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  UNIQUE (tenant_id, dedupe_key)
);
CREATE INDEX ix_notif_user ON platform.notifications (user_id, created_at DESC);

CREATE TABLE platform.push_subscriptions (    -- Web Push (VAPID) de la PWA
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES iam.users(id) ON DELETE CASCADE,
  endpoint   text NOT NULL UNIQUE,
  keys_enc   bytea NOT NULL,                -- {p256dh, auth} cifrado con libsodium (migración 0015)
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform.settings (
  tenant_id  uuid REFERENCES iam.tenants(id),
  key        text,
  value      jsonb NOT NULL,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE platform.exchange_rates (
  base       char(3) NOT NULL DEFAULT 'USD',
  quote      char(3) NOT NULL,
  rate       numeric(14,6) NOT NULL,
  valid_on   date NOT NULL,
  PRIMARY KEY (base, quote, valid_on)
);

-- =====================================================================
-- REPORTES (migración 1759000000013_reportes.js): único schema que lee otros
-- =====================================================================
CREATE SCHEMA reports;
-- Vistas materializadas (definición completa en la migración), con índice único
-- para REFRESH MATERIALIZED VIEW CONCURRENTLY cada 15 min desde el worker:
--   reports.mv_sales_daily          día × ciudad × barrio × método de pago × entrega × canal × courier × motorizado
--   reports.mv_sales_items_daily    día × categoría × talla × color × producto
--   reports.mv_delivery_performance día × tipo × courier × motorizado × zona (tiempos en sumas y tramos)
--   reports.mv_funnel_daily         día: carritos, abandonados, pedidos, ventas

CREATE TABLE reports.refresh_log (
  view_name    text PRIMARY KEY,
  refreshed_at timestamptz NOT NULL,
  duration_ms  int NOT NULL
);

CREATE TABLE reports.export_jobs (               -- exportes Excel/PDF asíncronos
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES iam.tenants(id),
  requested_by uuid NOT NULL REFERENCES iam.users(id),
  report       text NOT NULL CHECK (report IN ('sales','sales_items','delivery','funnel')),
  format       text NOT NULL CHECK (format IN ('xlsx','pdf')),
  params       jsonb NOT NULL,                   -- consulta validada y congelada
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  attempts     smallint NOT NULL DEFAULT 0,
  storage_key  text,                             -- clave en SeaweedFS (reports/exports/...)
  filename     text,
  size_bytes   int,
  row_count    int,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  expires_at   timestamptz,
  CHECK (status <> 'done' OR storage_key IS NOT NULL)
);
CREATE INDEX ix_export_jobs_pending ON reports.export_jobs (created_at) WHERE status IN ('queued','running');
CREATE INDEX ix_export_jobs_requester ON reports.export_jobs (tenant_id, requested_by, created_at DESC);

-- =====================================================================
-- PATRONES CRÍTICOS (referencia, no se ejecutan en la migración)
-- =====================================================================
-- 1) Reserva de stock atómica (ordenar ítems por variant_id para evitar deadlocks):
--   UPDATE inventory.stock_levels
--      SET reserved = reserved + $qty, version = version + 1, updated_at = now()
--    WHERE variant_id = $variant AND warehouse_id = $warehouse
--      AND on_hand - reserved >= $qty
--   RETURNING available;          -- 0 filas = sin stock
--
-- 2) Resolución de zona:
--   SELECT id, delivery_mode, base_fee, fee_per_km, free_shipping_threshold, serving_warehouse_id
--     FROM logistics.coverage_zones
--    WHERE tenant_id = $tenant AND active
--      AND ST_Covers(area, ST_SetSRID(ST_MakePoint($lng, $lat), 4326)::geography)
--    ORDER BY priority LIMIT 1;
--
-- 3) Secuencial SRI (misma transacción que crea el documento):
--   UPDATE billing.sequences SET last_value = last_value + 1
--    WHERE emission_point_id = $ep AND doc_type = '01'
--   RETURNING last_value;
--
-- 4) RLS multi-tenant (activar cuando llegue la segunda marca):
--   ALTER TABLE sales.orders ENABLE ROW LEVEL SECURITY;
--   CREATE POLICY tenant_isolation ON sales.orders
--     USING (tenant_id = current_setting('app.tenant_id')::uuid);
