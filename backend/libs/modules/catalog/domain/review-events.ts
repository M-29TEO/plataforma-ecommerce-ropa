import { DomainEvent } from '../../../shared-kernel';

export const REVIEW_SUBMITTED = 'ReviewSubmitted';
export const REVIEW_APPROVED = 'ReviewApproved';
export const REVIEW_REJECTED = 'ReviewRejected';
export const QUESTION_ANSWERED = 'QuestionAnswered';

/**
 * Consumidores previstos: Notificaciones (avisar al cliente que su reseña se publicó o por qué se
 * rechazó; alerta al backoffice de reseñas pendientes) y Reportes.
 */
export interface ReviewEventPayload {
  reviewId: string;
  productId: string;
  productName: string;
  userId: string;
  rating: number;
  verifiedPurchase: boolean;
  status: string;
  rejectionReason: string | null;
  ratingAvg: string;
  ratingCount: number;
}

/** Consumidor previsto: Notificaciones (avisar a quien preguntó). */
export interface QuestionAnsweredPayload {
  questionId: string;
  answerId: string;
  productId: string;
  productName: string;
  askedBy: string | null;
  isOfficial: boolean;
}

export function reviewEvent(tenantId: string, eventType: string, p: ReviewEventPayload): DomainEvent {
  return { tenantId, aggregateType: 'catalog.review', aggregateId: p.reviewId, eventType, payload: { ...p } };
}

export function questionAnswered(tenantId: string, p: QuestionAnsweredPayload): DomainEvent {
  return { tenantId, aggregateType: 'catalog.product_question', aggregateId: p.questionId, eventType: QUESTION_ANSWERED, payload: { ...p } };
}
