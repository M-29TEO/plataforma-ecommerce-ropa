/** Puertos de reseñas y preguntas (schema catalog). */
import { ObjectStorage, Queryable } from '../../../shared-kernel';
import { Answer, Question, QuestionStatus, Review, ReviewStatus } from '../domain/review';

/** Fotos de las reseñas (SeaweedFS o memoria). Token propio, como ReturnPhotoStorage en Posventa. */
export abstract class ReviewPhotoStorage extends ObjectStorage {}

export type ReviewSort = 'recent' | 'rating_desc' | 'rating_asc' | 'helpful';

export interface PublicReviewFilter {
  rating?: number;
  withPhotos?: boolean;
  verifiedOnly?: boolean;
  sort: ReviewSort;
  limit: number;
  offset: number;
}

export interface ReviewSummary {
  ratingAvg: string;
  ratingCount: number;
  /** Cantidad de reseñas aprobadas por estrellas: { '1': n, ..., '5': n }. */
  distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
  /** Cómo les quedó la talla (solo reseñas que lo indicaron). */
  fit: { small: number; true: number; large: number };
  withPhotos: number;
  verified: number;
}

export interface ReviewableProduct {
  id: string;
  name: string;
  ratingAvg: string;
  ratingCount: number;
}

export abstract class ReviewRepository {
  /** Producto del tenant no borrado. */
  abstract findProduct(q: Queryable, tenantId: string, productId: string, opts?: { forUpdate?: boolean }): Promise<ReviewableProduct | null>;
  /** Líneas de pedido ya reseñadas por el cliente en ese producto y si tiene una reseña sin compra. */
  abstract reviewedBy(q: Queryable, userId: string, productId: string): Promise<{ orderItemIds: string[]; hasUnverified: boolean }>;
  /** false si choca con un UNIQUE (reseña repetida por doble envío). */
  abstract insert(q: Queryable, review: Review): Promise<boolean>;
  abstract findById(q: Queryable, tenantId: string, id: string, opts?: { forUpdate?: boolean }): Promise<Review | null>;
  abstract saveModeration(q: Queryable, review: Review): Promise<void>;
  /** Recalcula rating_avg y rating_count del producto con las aprobadas. */
  abstract recomputeRating(q: Queryable, productId: string): Promise<{ ratingAvg: string; ratingCount: number }>;
  abstract listPublic(q: Queryable, tenantId: string, productId: string, filter: PublicReviewFilter): Promise<Review[]>;
  abstract summary(q: Queryable, tenantId: string, productId: string): Promise<ReviewSummary>;
  abstract listQueue(q: Queryable, tenantId: string, status: ReviewStatus, limit: number, offset: number): Promise<Array<Review & { productName: string }>>;
  abstract listByUser(q: Queryable, tenantId: string, userId: string): Promise<Array<Review & { productName: string }>>;
}

export abstract class QuestionRepository {
  abstract insert(q: Queryable, question: Question): Promise<void>;
  abstract findById(q: Queryable, tenantId: string, id: string, opts?: { forUpdate?: boolean }): Promise<Question | null>;
  abstract saveModeration(q: Queryable, question: Question): Promise<void>;
  abstract insertAnswer(q: Queryable, answer: Answer): Promise<void>;
  abstract listPublished(q: Queryable, tenantId: string, productId: string, limit: number, offset: number): Promise<Question[]>;
  abstract listQueue(q: Queryable, tenantId: string, status: QuestionStatus, limit: number, offset: number): Promise<Array<Question & { productName: string }>>;
}
