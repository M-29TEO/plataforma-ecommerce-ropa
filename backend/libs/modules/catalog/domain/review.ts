import { ConflictError, NotFoundError, ValidationError } from '../../../shared-kernel';

export const REVIEW_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const QUESTION_STATUSES = ['pending', 'published', 'rejected'] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

export const FIT_FEEDBACK = ['small', 'true', 'large'] as const;
export type FitFeedback = (typeof FIT_FEEDBACK)[number];

export const MAX_REVIEW_PHOTOS = 5;
export const REVIEW_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

export interface Review {
  id: string;
  productId: string;
  userId: string;
  /** Línea del pedido entregado: si no es null, la reseña es de "compra verificada". */
  orderItemId: string | null;
  rating: number;
  fitFeedback: FitFeedback | null;
  title: string | null;
  body: string | null;
  status: ReviewStatus;
  helpfulCount: number;
  rejectionReason: string | null;
  moderatedBy: string | null;
  moderatedAt: Date | null;
  createdAt: Date;
  /** Claves de las fotos en el almacenamiento, en orden. */
  photos: string[];
}

export interface Question {
  id: string;
  productId: string;
  userId: string | null;
  body: string;
  status: QuestionStatus;
  rejectionReason: string | null;
  moderatedBy: string | null;
  moderatedAt: Date | null;
  createdAt: Date;
  answers: Answer[];
}

export interface Answer {
  id: string;
  questionId: string;
  userId: string;
  isOfficial: boolean;
  body: string;
  createdAt: Date;
}

export class InvalidReviewError extends ValidationError {
  constructor(message: string, field?: string) {
    super('INVALID_REVIEW', message, field ? { field } : undefined);
  }
}

export class ReviewNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('REVIEW_NOT_FOUND', 'La reseña no existe', { id });
  }
}

export class QuestionNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('QUESTION_NOT_FOUND', 'La pregunta no existe', { id });
  }
}

export class CatalogProductNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('PRODUCT_NOT_FOUND', 'El producto no existe', { id });
  }
}

/** Ya reseñó esa compra (o, sin compra, ya reseñó el producto). */
export class AlreadyReviewedError extends ConflictError {
  constructor(productId: string, verified: boolean) {
    super(
      'ALREADY_REVIEWED',
      verified ? 'Ya reseñaste todas tus compras de este producto' : 'Ya dejaste una reseña de este producto',
      { productId },
    );
  }
}

/** Solo se moderan reseñas y preguntas pendientes (aprobar dos veces no recalcula el promedio). */
export class AlreadyModeratedError extends ConflictError {
  constructor(id: string, status: string) {
    super('ALREADY_MODERATED', `Ya fue moderada (${status})`, { id, status });
  }
}

function text(value: unknown, field: string, min: number, max: number, required: boolean): string | null {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    if (required) throw new InvalidReviewError(`Falta ${field}`, field);
    return null;
  }
  if (typeof value !== 'string') throw new InvalidReviewError(`${field} debe ser texto`, field);
  const t = value.trim().replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  if (t.length < min || t.length > max) throw new InvalidReviewError(`${field} debe tener entre ${min} y ${max} caracteres`, field);
  return t;
}

export interface ReviewInput {
  rating?: unknown;
  fitFeedback?: unknown;
  title?: unknown;
  body?: unknown;
}

export function normalizeReview(input: ReviewInput): Pick<Review, 'rating' | 'fitFeedback' | 'title' | 'body'> {
  if (!Number.isInteger(input.rating) || (input.rating as number) < 1 || (input.rating as number) > 5) {
    throw new InvalidReviewError('rating debe ser un entero de 1 a 5', 'rating');
  }
  const fit = input.fitFeedback ?? null;
  if (fit !== null && !(FIT_FEEDBACK as readonly unknown[]).includes(fit)) {
    throw new InvalidReviewError(`fitFeedback debe ser ${FIT_FEEDBACK.join(', ')}`, 'fitFeedback');
  }
  return {
    rating: input.rating as number,
    fitFeedback: fit as FitFeedback | null,
    title: text(input.title, 'title', 2, 120, false),
    body: text(input.body, 'body', 10, 2000, false),
  };
}

export const normalizeQuestionBody = (v: unknown): string => text(v, 'body', 10, 500, true)!;
export const normalizeAnswerBody = (v: unknown): string => text(v, 'body', 2, 2000, true)!;
export const normalizeRejectionReason = (v: unknown): string => text(v, 'reason', 3, 300, true)!;

export type ModerationFlag = 'contains_email' | 'contains_phone' | 'contains_url' | 'blocked_word';

/**
 * Palabras que marcan una reseña para revisión con más cuidado (no la rechazan solas). Lista corta
 * y editable; el moderador decide.
 */
const BLOCKED_WORDS = ['estafa', 'estafadores', 'idiota', 'imbecil', 'mierda', 'puta', 'hijueputa', 'verga', 'pendejo'];

/**
 * Marcas automáticas para la cola de moderación: datos de contacto (spam, o el cliente se expone
 * sin querer), enlaces y lenguaje ofensivo. Ninguna aprueba ni rechaza por sí sola.
 */
export function moderationFlags(...parts: Array<string | null | undefined>): ModerationFlag[] {
  const t = parts.filter(Boolean).join('\n');
  const plain = t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const flags: ModerationFlag[] = [];
  const email = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
  if (email.test(t)) flags.push('contains_email');
  if (/(\+?\d[\d\s-]{7,}\d)/.test(t)) flags.push('contains_phone');
  // El dominio de un email no cuenta como enlace.
  if (/(https?:\/\/|www\.|\b[\w-]+\.(com|ec|net|org|io|shop|store)\b)/i.test(t.replace(email, ' '))) flags.push('contains_url');
  if (BLOCKED_WORDS.some((w) => new RegExp(`\\b${w}\\b`).test(plain))) flags.push('blocked_word');
  return flags;
}

/** "Ana", "Pérez" → "Ana P." Sin nombre: "Cliente". Nunca el email. */
export function authorName(firstName: string | null | undefined, lastName: string | null | undefined): string {
  const first = firstName?.trim();
  if (!first) return 'Cliente';
  const initial = lastName?.trim()?.[0];
  return initial ? `${first} ${initial.toUpperCase()}.` : first;
}
