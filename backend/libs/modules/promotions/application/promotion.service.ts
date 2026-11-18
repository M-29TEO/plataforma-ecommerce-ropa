import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConflictError, Database, isUniqueViolation } from '../../../shared-kernel';
import { InvalidCouponCodeError, InvalidPromotionError, PromotionNotFoundError } from '../domain/errors';
import {
  CouponProps,
  isValidCouponCode,
  normalizeCouponCode,
  PromotionProps,
  validatePromotionDefinition,
  validatePromotionName,
  validatePromotionWindow,
} from '../domain/promotion';
import { PromotionFilter, PromotionPatch, PromotionRepository } from './ports';

export interface CreatePromotionInput {
  name: string;
  type: string;
  conditions?: unknown;
  benefit: unknown;
  requiresCoupon?: boolean;
  stackable?: boolean;
  priority?: number;
  maxUses?: number | null;
  startsAt: Date;
  endsAt?: Date | null;
  active?: boolean;
}

export type UpdatePromotionInput = Partial<Omit<CreatePromotionInput, 'type'>>;

export interface CreateCouponInput {
  code: string;
  maxUses?: number | null;
  maxUsesPerCustomer?: number;
  assignedUserId?: string | null;
}

export type PromotionDetail = PromotionProps & { coupons: CouponProps[] };

export interface RewardCouponInput {
  tenantId: string;
  userId: string;
  /** Nombre de la promoción de sistema, p. ej. "Recompensa por referido". */
  promotionName: string;
  /** Monto fijo "10.00" (solo al crear la promoción). */
  amount: string;
  /** Mínimo de compra "30.00" (solo al crear la promoción). */
  minSubtotal?: string | null;
  /** Prefijo del código: "REF" → REF-7KQ2M9XA. */
  codePrefix: string;
}

export interface IssuedRewardCoupon {
  promotionId: string;
  couponId: string;
  code: string;
  amount: string;
}

function assertLimits(input: { priority?: number; maxUses?: number | null }): void {
  if (input.priority !== undefined && (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 10_000)) {
    throw new InvalidPromotionError('priority debe ser un entero entre 0 y 10000', 'priority');
  }
  if (input.maxUses !== undefined && input.maxUses !== null && (!Number.isInteger(input.maxUses) || input.maxUses < 1)) {
    throw new InvalidPromotionError('maxUses debe ser un entero positivo o null (sin límite)', 'maxUses');
  }
}

/** Backoffice: alta y edición de promociones y cupones. */
@Injectable()
export class PromotionService {
  constructor(
    private readonly db: Database,
    private readonly promotions: PromotionRepository,
  ) {}

  async create(tenantId: string, input: CreatePromotionInput, now = new Date()): Promise<PromotionProps> {
    const { type, conditions, benefit } = validatePromotionDefinition(input);
    assertLimits(input);
    const endsAt = input.endsAt ?? null;
    validatePromotionWindow(input.startsAt, endsAt);
    const promotion: PromotionProps = {
      id: randomUUID(),
      tenantId,
      name: validatePromotionName(input.name),
      type,
      conditions,
      benefit,
      requiresCoupon: input.requiresCoupon ?? false,
      stackable: input.stackable ?? false,
      priority: input.priority ?? 100,
      maxUses: input.maxUses ?? null,
      usedCount: 0,
      startsAt: input.startsAt,
      endsAt,
      active: input.active ?? true,
      createdAt: now,
    };
    await this.promotions.insert(this.db, promotion);
    return promotion;
  }

  /** El tipo no cambia (cambiaría el significado de benefit); conditions/benefit se revalidan con él. */
  async update(tenantId: string, id: string, input: UpdatePromotionInput): Promise<PromotionProps> {
    const current = await this.load(tenantId, id);
    assertLimits(input);
    const patch: PromotionPatch = {
      requiresCoupon: input.requiresCoupon,
      stackable: input.stackable,
      priority: input.priority,
      maxUses: input.maxUses,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      active: input.active,
    };
    if (input.name !== undefined) patch.name = validatePromotionName(input.name);
    if (input.conditions !== undefined || input.benefit !== undefined) {
      const def = validatePromotionDefinition({
        type: current.type,
        conditions: input.conditions ?? current.conditions,
        benefit: input.benefit ?? current.benefit,
      });
      patch.conditions = def.conditions;
      patch.benefit = def.benefit;
    }
    validatePromotionWindow(input.startsAt ?? current.startsAt, input.endsAt === undefined ? current.endsAt : input.endsAt);
    const updated = await this.promotions.update(this.db, tenantId, id, patch);
    if (!updated) throw new PromotionNotFoundError(id);
    return updated;
  }

  async get(tenantId: string, id: string): Promise<PromotionDetail> {
    const promotion = await this.load(tenantId, id);
    return { ...promotion, coupons: await this.promotions.listCoupons(this.db, tenantId, id) };
  }

  list(tenantId: string, filter: PromotionFilter): Promise<PromotionProps[]> {
    return this.promotions.list(this.db, tenantId, filter);
  }

  async createCoupon(tenantId: string, promotionId: string, input: CreateCouponInput): Promise<CouponProps> {
    await this.load(tenantId, promotionId);
    if (!isValidCouponCode(input.code)) throw new InvalidCouponCodeError(input.code);
    const perCustomer = input.maxUsesPerCustomer ?? 1;
    if (!Number.isInteger(perCustomer) || perCustomer < 1) {
      throw new InvalidPromotionError('maxUsesPerCustomer debe ser un entero positivo', 'maxUsesPerCustomer');
    }
    assertLimits({ maxUses: input.maxUses });
    const coupon: CouponProps = {
      id: randomUUID(),
      promotionId,
      tenantId,
      code: normalizeCouponCode(input.code),
      maxUses: input.maxUses ?? null,
      maxUsesPerCustomer: perCustomer,
      usedCount: 0,
      assignedUserId: input.assignedUserId ?? null,
    };
    try {
      await this.promotions.insertCoupon(this.db, coupon);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('COUPON_CODE_TAKEN', 'Ya existe un cupón con ese código', { code: coupon.code });
      }
      throw error;
    }
    return coupon;
  }

  /**
   * Cupón personal de un solo uso bajo una promoción "de sistema" (por nombre), que se crea la
   * primera vez con el monto y mínimo indicados (monto fijo, requiere cupón). Después el backoffice
   * la edita como cualquier otra: cambiar el monto o desactivarla rige para los cupones nuevos; si
   * está desactivada no se emite nada (null). El candado evita crear la promoción dos veces.
   */
  async issueRewardCoupon(input: RewardCouponInput, now = new Date()): Promise<IssuedRewardCoupon | null> {
    return this.db.withTransaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`promotions.reward:${input.tenantId}:${input.promotionName}`]);
      let promotion = await this.promotions.findRewardPromotion(tx, input.tenantId, input.promotionName);
      if (!promotion) {
        promotion = await this.create(
          input.tenantId,
          {
            name: input.promotionName,
            type: 'fixed',
            conditions: input.minSubtotal ? { minSubtotal: input.minSubtotal } : {},
            benefit: { amount: input.amount },
            requiresCoupon: true,
            startsAt: now,
          },
          now,
        );
      }
      if (!promotion.active || (promotion.endsAt && promotion.endsAt <= now)) return null;
      for (let attempt = 1; ; attempt++) {
        const code = `${input.codePrefix}-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
        try {
          // SAVEPOINT: un código repetido (unique violation) no aborta la transacción de afuera.
          const coupon = await this.db.withTransaction(() =>
            this.createCoupon(input.tenantId, promotion!.id, { code, maxUses: 1, maxUsesPerCustomer: 1, assignedUserId: input.userId }),
          );
          return { promotionId: promotion.id, couponId: coupon.id, code: coupon.code, amount: String((promotion.benefit as { amount?: string }).amount ?? input.amount) };
        } catch (error) {
          if (!(error instanceof ConflictError) || attempt >= 3) throw error;
        }
      }
    });
  }

  private async load(tenantId: string, id: string): Promise<PromotionProps> {
    const promotion = await this.promotions.findById(this.db, tenantId, id);
    if (!promotion) throw new PromotionNotFoundError(id);
    return promotion;
  }
}
