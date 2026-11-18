import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig, Database, fromCents, ivaCents, ivaRateBp, OutboxWriter, toCents } from '../../../shared-kernel';
import { CatalogApi } from '../../catalog';
import type { ProductOffer } from '../../catalog';
import { InventoryApi } from '../../inventory';
import { InvalidWishlistVariantError, ProductNotFoundError, WishlistItemNotFoundError, WishlistLimitError } from '../domain/errors';
import { WISHLIST_BACK_IN_STOCK, WISHLIST_PRICE_DROPPED, wishlistAlert } from '../domain/events';
import { AlertRules, evaluateWishlistItem, MAX_WISHLIST_ITEMS, WishlistObservation } from '../domain/wishlist';
import { WishlistItem, WishlistRepository, WishlistScanCursor } from './ports';

export interface WishlistItemView {
  productId: string;
  variantId: string | null;
  productName: string | null;
  slug: string | null;
  /** Precio vigente sin IVA y con IVA (el menor de las tallas si no se eligió una). */
  price: string | null;
  priceWithTax: string | null;
  inStock: boolean;
  /** false si el producto se archivó o se borró: se muestra como "ya no disponible". */
  available: boolean;
  notifyBackInStock: boolean;
  notifyPriceDrop: boolean;
  addedAt: Date;
}

export interface AddToWishlistInput {
  productId: string;
  variantId?: string | null;
  notifyBackInStock?: boolean;
  notifyPriceDrop?: boolean;
}

export interface ScanResult {
  scanned: number;
  backInStock: number;
  priceDrops: number;
}

const SCAN_PAGE = 200;

export function withTax(price: string, taxCode: string): string {
  const cents = toCents(price);
  return fromCents(cents + ivaCents(cents, ivaRateBp(taxCode)));
}

/** Precio y stock de un ítem (producto o una variante) según Catálogo e Inventario. */
export function observe(offer: ProductOffer | undefined, variantId: string | null, availability: ReadonlyMap<string, number>): WishlistObservation {
  if (!offer) return { price: null, inStock: false };
  const variants = offer.variants.filter((v) => v.purchasable && (variantId === null || v.variantId === variantId));
  if (variants.length === 0) return { price: null, inStock: false };
  const price = variants.reduce((min, v) => (toCents(v.price) < toCents(min) ? v.price : min), variants[0].price);
  const inStock = offer.purchasable && variants.some((v) => (availability.get(v.variantId) ?? 0) > 0);
  return { price, inStock };
}

function variantIdsOf(offers: Iterable<ProductOffer>): string[] {
  return [...offers].flatMap((o) => o.variants.map((v) => v.variantId));
}

/**
 * Lista de deseos del cliente y alertas de reposición y bajada de precio. Las alertas las decide
 * un job que compara precio y stock con la última observación guardada (no hay eventos de cambio
 * de precio: el Catálogo todavía no tiene escritura). Se emiten como eventos al outbox y
 * Notificaciones las envía como marketing (con consentimiento del canal).
 */
@Injectable()
export class WishlistService {
  private readonly logger = new Logger(WishlistService.name);

  constructor(
    private readonly db: Database,
    private readonly wishlist: WishlistRepository,
    private readonly catalog: CatalogApi,
    private readonly inventory: InventoryApi,
    private readonly outbox: OutboxWriter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async list(tenantId: string, userId: string): Promise<WishlistItemView[]> {
    const items = await this.wishlist.list(this.db, tenantId, userId);
    const offers = await this.catalog.getProductOffers(tenantId, items.map((i) => i.productId));
    const availability = await this.inventory.getAvailability(tenantId, variantIdsOf(offers.values()));
    return items.map((i) => this.view(i, offers.get(i.productId), availability));
  }

  /** Agregar dos veces el mismo producto actualiza la talla y las preferencias. */
  async add(tenantId: string, userId: string, input: AddToWishlistInput): Promise<WishlistItemView> {
    const offers = await this.catalog.getProductOffers(tenantId, [input.productId]);
    const offer = offers.get(input.productId);
    if (!offer) throw new ProductNotFoundError(input.productId);
    const variantId = input.variantId ?? null;
    if (variantId && !offer.variants.some((v) => v.variantId === variantId)) throw new InvalidWishlistVariantError(variantId);
    const availability = await this.inventory.getAvailability(tenantId, variantIdsOf([offer]));
    const now = observe(offer, variantId, availability);

    const saved = await this.db.withTransaction(async (tx) => {
      await this.wishlist.lockOwner(tx, tenantId, userId);
      const existing = await this.wishlist.find(tx, tenantId, userId, input.productId);
      if (!existing && (await this.wishlist.count(tx, tenantId, userId)) >= MAX_WISHLIST_ITEMS) throw new WishlistLimitError(MAX_WISHLIST_ITEMS);
      return this.wishlist.upsert(tx, {
        tenantId,
        userId,
        productId: input.productId,
        variantId,
        notifyBackInStock: input.notifyBackInStock ?? existing?.notifyBackInStock ?? true,
        notifyPriceDrop: input.notifyPriceDrop ?? existing?.notifyPriceDrop ?? true,
        // Al agregar (o cambiar de talla) la referencia es lo que el cliente ve ahora: no se avisa de inmediato.
        lastKnownPrice: now.price,
        lastKnownInStock: now.inStock,
        lastAlertedAt: existing?.lastAlertedAt ?? null,
        addedAt: existing?.addedAt ?? new Date(),
      });
    });
    return this.view(saved, offer, availability);
  }

  async updatePreferences(tenantId: string, userId: string, productId: string, patch: { notifyBackInStock?: boolean; notifyPriceDrop?: boolean }): Promise<WishlistItemView> {
    const current = await this.wishlist.find(this.db, tenantId, userId, productId);
    if (!current) throw new WishlistItemNotFoundError(productId);
    const saved = await this.wishlist.upsert(this.db, {
      ...current,
      notifyBackInStock: patch.notifyBackInStock ?? current.notifyBackInStock,
      notifyPriceDrop: patch.notifyPriceDrop ?? current.notifyPriceDrop,
    });
    const offers = await this.catalog.getProductOffers(tenantId, [productId]);
    const availability = await this.inventory.getAvailability(tenantId, variantIdsOf(offers.values()));
    return this.view(saved, offers.get(productId), availability);
  }

  async remove(tenantId: string, userId: string, productId: string): Promise<void> {
    if (!(await this.wishlist.delete(this.db, tenantId, userId, productId))) throw new WishlistItemNotFoundError(productId);
  }

  /**
   * Job: recorre todas las wishlists por páginas, observa precio y stock en lote (por tenant) y
   * guarda la observación; las alertas van al outbox en la MISMA transacción que la observación,
   * así un reintento no duplica avisos. tenantId limita la pasada a un tenant (tests).
   */
  async scan(at = new Date(), tenantId: string | null = null): Promise<ScanResult> {
    const rules: AlertRules = { minDropBp: this.config.crm.wishlistMinDropBp, cooldownMs: this.config.crm.wishlistAlertCooldownHours * 3600_000 };
    const result: ScanResult = { scanned: 0, backInStock: 0, priceDrops: 0 };
    let cursor: WishlistScanCursor | null = null;
    for (;;) {
      const page = await this.wishlist.listForScan(this.db, cursor, SCAN_PAGE, tenantId);
      if (page.length === 0) break;
      const last: WishlistItem = page[page.length - 1];
      cursor = { tenantId: last.tenantId, userId: last.userId, productId: last.productId };
      const byTenant = new Map<string, WishlistItem[]>();
      for (const item of page) byTenant.set(item.tenantId, [...(byTenant.get(item.tenantId) ?? []), item]);
      for (const [tenant, items] of byTenant) await this.scanTenant(tenant, items, rules, at, result);
      if (page.length < SCAN_PAGE) break;
    }
    return result;
  }

  private async scanTenant(tenantId: string, items: WishlistItem[], rules: AlertRules, at: Date, result: ScanResult): Promise<void> {
    const offers = await this.catalog.getProductOffers(tenantId, items.map((i) => i.productId));
    const availability = await this.inventory.getAvailability(tenantId, variantIdsOf(offers.values()));
    for (const item of items) {
      result.scanned++;
      const offer = offers.get(item.productId);
      const now = observe(offer, item.variantId, availability);
      const { alerts, next } = evaluateWishlistItem(item, now, rules, at);
      const unchanged =
        next.lastKnownPrice === item.lastKnownPrice && next.lastKnownInStock === item.lastKnownInStock && next.lastAlertedAt === item.lastAlertedAt;
      if (alerts.length === 0 && unchanged) continue;
      try {
        await this.db.withTransaction(async (tx) => {
          await this.wishlist.saveObservation(tx, item, next);
          const events = alerts.map((a) => {
            const base = {
              userId: item.userId,
              productId: item.productId,
              variantId: item.variantId,
              productName: offer!.name,
              price: now.price!,
              priceWithTax: withTax(now.price!, offer!.taxCode),
              observedAt: at.toISOString(),
            };
            return a === 'back_in_stock'
              ? wishlistAlert(tenantId, WISHLIST_BACK_IN_STOCK, base)
              : wishlistAlert(tenantId, WISHLIST_PRICE_DROPPED, {
                  ...base,
                  previousPrice: item.lastKnownPrice!,
                  previousPriceWithTax: withTax(item.lastKnownPrice!, offer!.taxCode),
                });
          });
          await this.outbox.append(tx, events);
        });
        for (const a of alerts) if (a === 'back_in_stock') result.backInStock++; else result.priceDrops++;
      } catch (e) {
        // Un ítem con error no detiene la pasada; se reintenta en la siguiente.
        this.logger.error(`Wishlist ${item.userId}/${item.productId}: ${(e as Error).message}`);
      }
    }
  }

  private view(i: WishlistItem, offer: ProductOffer | undefined, availability: ReadonlyMap<string, number>): WishlistItemView {
    const now = observe(offer, i.variantId, availability);
    return {
      productId: i.productId,
      variantId: i.variantId,
      productName: offer?.name ?? null,
      slug: offer?.slug ?? null,
      price: now.price,
      priceWithTax: now.price && offer ? withTax(now.price, offer.taxCode) : null,
      inStock: now.inStock,
      available: !!offer && offer.purchasable && now.price !== null,
      notifyBackInStock: i.notifyBackInStock,
      notifyPriceDrop: i.notifyPriceDrop,
      addedAt: i.addedAt,
    };
  }
}
