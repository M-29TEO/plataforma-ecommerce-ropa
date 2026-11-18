/** Puertos de persistencia del módulo Carrito (schema sales: carts, cart_items). */
import { Queryable } from '../../../shared-kernel';
import { Cart } from '../domain/cart';

export interface LockOption {
  forUpdate?: boolean;
}

/** Carrito candidato a recordatorio (activo, con ítems y con a quién escribirle). */
export interface AbandonmentCandidate {
  id: string;
  tenantId: string;
  userId: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  remindersSent: number;
  lastActivityAt: Date;
}

export abstract class CartRepository {
  abstract findActiveByUser(q: Queryable, tenantId: string, userId: string, opts?: LockOption): Promise<Cart | null>;
  /** Solo carritos de invitado activos con actividad posterior a `activeSince`. */
  abstract findActiveByGuestToken(
    q: Queryable,
    tenantId: string,
    tokenHash: Buffer,
    activeSince: Date,
    opts?: LockOption,
  ): Promise<Cart | null>;
  abstract findById(q: Queryable, tenantId: string, id: string, opts?: LockOption): Promise<Cart | null>;
  /**
   * Inserta el carrito sin ítems. Devuelve false si el usuario ya tiene un carrito activo
   * (índice único ux_cart_user_active): otra petición lo creó al mismo tiempo.
   */
  abstract insert(q: Queryable, cart: Cart): Promise<boolean>;
  /**
   * Cabecera + reemplazo de las líneas. Se llama con la fila del carrito bloqueada. Si cambió
   * last_activity_at, reminders_sent vuelve a 0 (el cliente volvió: la cuenta se reinicia).
   */
  abstract save(q: Queryable, cart: Cart): Promise<void>;
  /**
   * Carritos activos con ítems, inactivos desde antes de `idleBefore`, con menos de `maxReminders`
   * recordatorios y con contacto (email/teléfono del carrito o usuario). Filas BLOQUEADAS con SKIP
   * LOCKED: dos réplicas del job no toman el mismo carrito.
   */
  abstract claimAbandonmentCandidates(
    q: Queryable,
    idleBefore: Date,
    maxReminders: number,
    limit: number,
    tenantId?: string,
  ): Promise<AbandonmentCandidate[]>;
  /** UPDATE condicional atómico: solo si el carrito sigue activo y reminders_sent sigue siendo `expected`. */
  abstract recordReminder(q: Queryable, cartId: string, expected: number, sent: number): Promise<boolean>;
}
