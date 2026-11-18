import { ConflictError, ValidationError } from '../../../shared-kernel';

/**
 * Calificación mutua de una entrega con motorizado (logistics.ratings):
 *  - 'customer': el cliente califica al motorizado → actualiza riders.rating_avg / rating_count.
 *  - 'rider': el motorizado califica al cliente (evento CustomerRated para CRM).
 * Una por envío y por lado (UNIQUE (shipment_id, rater_type)). rater_id y ratee_id son siempre
 * iam.users.id (el motorizado se identifica por riders.user_id).
 */
export const RATER_TYPES = ['customer', 'rider'] as const;
export type RaterType = (typeof RATER_TYPES)[number];

/** Días desde la entrega en los que se puede calificar. */
export const RATING_WINDOW_DAYS = 7;
export const MAX_RATING_TAGS = 5;
export const MAX_RATING_COMMENT = 500;

/** Etiquetas permitidas según quién califica (se validan para poder agregarlas en reportes). */
export const RATING_TAGS: Record<RaterType, readonly string[]> = {
  customer: ['puntual', 'amable', 'cuidadoso', 'buena_comunicacion', 'impuntual', 'descortes', 'paquete_danado', 'no_siguio_indicaciones'],
  rider: ['amable', 'ubicacion_precisa', 'listo_para_recibir', 'no_contesta', 'direccion_incorrecta', 'descortes', 'espera_prolongada'],
};

export interface RatingInput {
  score: number;
  tags?: string[];
  comment?: string | null;
}

export interface NormalizedRating {
  score: number;
  tags: string[];
  comment: string | null;
}

export function normalizeRating(raterType: RaterType, input: RatingInput): NormalizedRating {
  if (!Number.isInteger(input.score) || input.score < 1 || input.score > 5) {
    throw new ValidationError('INVALID_RATING', 'La calificación debe ser un entero de 1 a 5', { score: input.score });
  }
  const tags = [...new Set((input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))];
  if (tags.length > MAX_RATING_TAGS) {
    throw new ValidationError('INVALID_RATING', `Máximo ${MAX_RATING_TAGS} etiquetas`, { tags });
  }
  const unknown = tags.filter((t) => !RATING_TAGS[raterType].includes(t));
  if (unknown.length > 0) {
    throw new ValidationError('INVALID_RATING_TAG', 'Etiqueta no permitida', { unknown, allowed: RATING_TAGS[raterType] });
  }
  const comment = input.comment?.trim() || null;
  if (comment && comment.length > MAX_RATING_COMMENT) {
    throw new ValidationError('INVALID_RATING', `El comentario admite hasta ${MAX_RATING_COMMENT} caracteres`);
  }
  return { score: input.score, tags, comment };
}

export type NotRateableReason = 'NOT_DELIVERED' | 'WINDOW_CLOSED';

export class ShipmentNotRateableError extends ConflictError {
  constructor(shipmentId: string, reason: NotRateableReason) {
    super(
      'SHIPMENT_NOT_RATEABLE',
      reason === 'NOT_DELIVERED'
        ? 'Solo se califica una entrega completada'
        : `El plazo para calificar venció (${RATING_WINDOW_DAYS} días desde la entrega)`,
      { shipmentId, reason },
    );
  }
}

/** Solo entregas con motorizado ya entregadas y dentro del plazo. */
export function assertRateable(
  s: { id: string; status: string; deliveredAt: Date | null },
  now: Date,
): void {
  if (s.status !== 'delivered' || !s.deliveredAt) throw new ShipmentNotRateableError(s.id, 'NOT_DELIVERED');
  if (now.getTime() - s.deliveredAt.getTime() > RATING_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
    throw new ShipmentNotRateableError(s.id, 'WINDOW_CLOSED');
  }
}
