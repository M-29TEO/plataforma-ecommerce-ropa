/**
 * Puertos del módulo CRM (schema crm). Mismo criterio que el resto: clases abstractas como tokens
 * de Nest y el Queryable de la transacción en curso.
 */
import { Queryable } from '../../../shared-kernel';
import { AddressProps } from '../domain/address';
import { GeocodeAttempt, GeocodeCandidate } from '../domain/geocoding';
import { LoyaltyAccount, LoyaltyTier, LoyaltyTransaction, LoyaltyTxStatus, LoyaltyTxType } from '../domain/loyalty';
import { Referral } from '../domain/referral';

// ------------------------------------------------------------------ geocodificación

/** Geocodificador (Nominatim). Devuelve candidatos ordenados por relevancia; [] si no encuentra. */
export abstract class GeocoderPort {
  /** false si no hay geocodificador configurado (NOMINATIM_URL vacío). */
  abstract readonly enabled: boolean;
  /** Lanza GeocoderUnavailableError si el servicio no responde a tiempo o falla. */
  abstract search(attempt: GeocodeAttempt): Promise<GeocodeCandidate[]>;
}

export class GeocoderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeocoderUnavailableError';
  }
}

// ------------------------------------------------------------------ direcciones

export abstract class AddressRepository {
  /** Serializa las operaciones de direcciones de un cliente (límite y predeterminada). */
  abstract lockOwner(q: Queryable, tenantId: string, userId: string): Promise<void>;
  abstract insert(q: Queryable, a: AddressProps): Promise<void>;
  abstract update(q: Queryable, a: AddressProps): Promise<void>;
  abstract findById(q: Queryable, tenantId: string, userId: string, id: string): Promise<AddressProps | null>;
  abstract list(q: Queryable, tenantId: string, userId: string): Promise<AddressProps[]>;
  abstract count(q: Queryable, tenantId: string, userId: string): Promise<number>;
  abstract delete(q: Queryable, tenantId: string, userId: string, id: string): Promise<boolean>;
  abstract clearDefault(q: Queryable, tenantId: string, userId: string): Promise<void>;
  /** La más reciente pasa a ser la predeterminada (al borrar la que lo era). */
  abstract promoteLatestAsDefault(q: Queryable, tenantId: string, userId: string): Promise<void>;
}

// ------------------------------------------------------------------ wishlist

export interface WishlistItem {
  tenantId: string;
  userId: string;
  productId: string;
  variantId: string | null;
  notifyBackInStock: boolean;
  notifyPriceDrop: boolean;
  lastKnownPrice: string | null;
  lastKnownInStock: boolean | null;
  lastAlertedAt: Date | null;
  addedAt: Date;
}

export interface WishlistObservationUpdate {
  lastKnownPrice: string | null;
  lastKnownInStock: boolean;
  lastAlertedAt: Date | null;
}

export interface WishlistScanCursor {
  tenantId: string;
  userId: string;
  productId: string;
}

export abstract class WishlistRepository {
  abstract lockOwner(q: Queryable, tenantId: string, userId: string): Promise<void>;
  abstract list(q: Queryable, tenantId: string, userId: string): Promise<WishlistItem[]>;
  abstract count(q: Queryable, tenantId: string, userId: string): Promise<number>;
  abstract find(q: Queryable, tenantId: string, userId: string, productId: string): Promise<WishlistItem | null>;
  /** Inserta o, si ya estaba, cambia variante y preferencias (conserva la observación y added_at). */
  abstract upsert(q: Queryable, item: WishlistItem): Promise<WishlistItem>;
  abstract delete(q: Queryable, tenantId: string, userId: string, productId: string): Promise<boolean>;
  /** Página del job (orden tenant, usuario, producto). tenantId limita a un tenant (tests). */
  abstract listForScan(q: Queryable, after: WishlistScanCursor | null, limit: number, tenantId?: string | null): Promise<WishlistItem[]>;
  abstract saveObservation(q: Queryable, item: Pick<WishlistItem, 'tenantId' | 'userId' | 'productId'>, next: WishlistObservationUpdate): Promise<void>;
}

// ------------------------------------------------------------------ puntos y niveles

export type NewLoyaltyTransaction = Omit<LoyaltyTransaction, 'id' | 'createdAt'>;

export interface DueOrder {
  tenantId: string;
  userId: string;
  orderId: string;
}

export abstract class LoyaltyRepository {
  abstract listTiers(q: Queryable, tenantId: string): Promise<LoyaltyTier[]>;
  abstract findTier(q: Queryable, tenantId: string, id: string): Promise<LoyaltyTier | null>;
  abstract insertTier(q: Queryable, tier: LoyaltyTier): Promise<void>;
  abstract updateTier(q: Queryable, tier: LoyaltyTier): Promise<void>;
  /** false si no existe; lanza unique/FK si hay cuentas en el nivel (el servicio lo traduce). */
  abstract deleteTier(q: Queryable, tenantId: string, id: string): Promise<boolean>;
  abstract countAccountsInTier(q: Queryable, tierId: string): Promise<number>;

  /** Crea la cuenta si no existe (idempotente). */
  abstract ensureAccount(q: Queryable, tenantId: string, userId: string, tierId: string | null): Promise<void>;
  abstract findAccount(q: Queryable, tenantId: string, userId: string, opts?: { forUpdate?: boolean }): Promise<LoyaltyAccount | null>;
  abstract saveAccount(q: Queryable, account: LoyaltyAccount): Promise<void>;

  /** null si ya existe un movimiento con el mismo (tenant, type, reference): evento repetido. */
  abstract insertTransaction(q: Queryable, tx: NewLoyaltyTransaction): Promise<LoyaltyTransaction | null>;
  abstract findByReference(q: Queryable, tenantId: string, type: LoyaltyTxType, reference: string): Promise<LoyaltyTransaction | null>;
  abstract listOrderTransactions(q: Queryable, tenantId: string, orderId: string): Promise<LoyaltyTransaction[]>;
  abstract setOrderStatus(q: Queryable, tenantId: string, orderId: string, from: LoyaltyTxStatus, to: LoyaltyTxStatus): Promise<void>;
  abstract listTransactions(q: Queryable, tenantId: string, userId: string, limit: number, offset: number): Promise<LoyaltyTransaction[]>;
  abstract listPending(q: Queryable, tenantId: string, userId: string): Promise<LoyaltyTransaction[]>;
  /** Pedidos con una acumulación pendiente cuyo plazo venció (available_at <= now). */
  abstract dueOrders(q: Queryable, now: Date, limit: number, tenantId?: string | null): Promise<DueOrder[]>;
  /** Pospone la acreditación de un pedido (tiene una devolución abierta). */
  abstract postpone(q: Queryable, tenantId: string, orderId: string, until: Date): Promise<void>;
}

// ------------------------------------------------------------------ referidos

export interface CustomerProfile {
  userId: string;
  tenantId: string;
  referralCode: string | null;
}

export abstract class ReferralRepository {
  abstract findProfile(q: Queryable, tenantId: string, userId: string): Promise<CustomerProfile | null>;
  /** Crea el perfil o le pone código si no tenía. false si el código ya existe (otro cliente). */
  abstract setReferralCode(q: Queryable, tenantId: string, userId: string, code: string): Promise<boolean>;
  abstract findProfileByCode(q: Queryable, tenantId: string, code: string): Promise<CustomerProfile | null>;
  /** false si el referido ya tenía un referente (UNIQUE referee_id). */
  abstract insert(q: Queryable, r: Referral): Promise<boolean>;
  abstract findByReferee(q: Queryable, tenantId: string, refereeId: string, opts?: { forUpdate?: boolean }): Promise<Referral | null>;
  abstract findById(q: Queryable, tenantId: string, id: string, opts?: { forUpdate?: boolean }): Promise<Referral | null>;
  abstract update(q: Queryable, r: Referral): Promise<void>;
  abstract listByReferrer(q: Queryable, tenantId: string, referrerId: string): Promise<Referral[]>;
  /** Calificados por id (paginado con after = último id visto). */
  abstract listQualified(q: Queryable, after: string | null, limit: number, tenantId?: string | null): Promise<Referral[]>;
}
