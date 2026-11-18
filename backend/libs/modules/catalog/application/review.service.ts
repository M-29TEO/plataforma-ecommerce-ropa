import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Database, OutboxWriter, StoredObject, ValidationError } from '../../../shared-kernel';
import { IamApi } from '../../iam';
import { OrdersApi } from '../../orders';
import {
  AlreadyModeratedError,
  AlreadyReviewedError,
  Answer,
  authorName,
  CatalogProductNotFoundError,
  InvalidReviewError,
  MAX_REVIEW_PHOTOS,
  moderationFlags,
  ModerationFlag,
  normalizeAnswerBody,
  normalizeQuestionBody,
  normalizeRejectionReason,
  normalizeReview,
  Question,
  QuestionNotFoundError,
  QuestionStatus,
  Review,
  REVIEW_PHOTO_MAX_BYTES,
  ReviewInput,
  ReviewNotFoundError,
  ReviewStatus,
} from '../domain/review';
import { questionAnswered, REVIEW_APPROVED, REVIEW_REJECTED, REVIEW_SUBMITTED, reviewEvent } from '../domain/review-events';
import { PublicReviewFilter, QuestionRepository, ReviewPhotoStorage, ReviewRepository, ReviewSummary } from './review-ports';

export interface PhotoFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

/** Firma de los primeros bytes: no basta el Content-Type que declara el navegador. */
const PHOTO_TYPES: Record<string, { ext: string; magic: (b: Buffer) => boolean }> = {
  'image/jpeg': { ext: 'jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { ext: 'png', magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/webp': { ext: 'webp', magic: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
};

const photoPrefix = (tenantId: string, userId: string) => `reviews/${tenantId}/${userId}/`;
const PHOTO_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;

/** Lo que ve el público: sin user_id (solo nombre e inicial) ni datos de moderación. */
export interface PublicReview {
  id: string;
  rating: number;
  fitFeedback: Review['fitFeedback'];
  title: string | null;
  body: string | null;
  author: string;
  verifiedPurchase: boolean;
  photoCount: number;
  helpfulCount: number;
  createdAt: Date;
}

export interface CreateReviewCommand extends ReviewInput {
  tenantId: string;
  userId: string;
  productId: string;
  photos?: string[];
}

export type ModerationReview = Review & { productName: string; verifiedPurchase: boolean; flags: ModerationFlag[] };

/**
 * Reseñas con fotos, moderación y "compra verificada", y preguntas y respuestas de productos.
 *  - Compra verificada: la reseña se liga a una línea de un pedido ENTREGADO del cliente para ese
 *    producto (Pedidos, por OrdersApi). Una reseña por línea; sin compra, una por producto.
 *  - Todo entra 'pending'. Al aprobar o rechazar se bloquea el producto y se recalcula su promedio
 *    en la misma transacción (dos moderaciones simultáneas no pisan el promedio).
 *  - Las fotos solo se sirven públicamente cuando la reseña está aprobada.
 */
@Injectable()
export class ReviewService {
  constructor(
    private readonly db: Database,
    private readonly reviews: ReviewRepository,
    private readonly questions: QuestionRepository,
    private readonly photos: ReviewPhotoStorage,
    private readonly orders: OrdersApi,
    private readonly iam: IamApi,
    private readonly outbox: OutboxWriter,
  ) {}

  // ------------------------------------------------------------------ cliente: reseñas

  async uploadPhoto(tenantId: string, userId: string, file: PhotoFile | undefined): Promise<{ key: string; contentType: string }> {
    if (!file || file.size === 0) throw new ValidationError('PHOTO_REQUIRED', 'Adjunta la foto (campo "photo")');
    const type = PHOTO_TYPES[file.mimetype];
    if (!type) throw new ValidationError('PHOTO_TYPE', 'La foto debe ser JPG, PNG o WEBP', { mimetype: file.mimetype });
    if (file.size > REVIEW_PHOTO_MAX_BYTES) throw new ValidationError('PHOTO_TOO_LARGE', 'La foto supera 5 MB');
    if (!type.magic(file.buffer)) throw new ValidationError('PHOTO_TYPE', 'El archivo no es una imagen válida');
    const key = `${photoPrefix(tenantId, userId)}${randomUUID()}.${type.ext}`;
    await this.photos.put(key, file.buffer, file.mimetype);
    return { key, contentType: file.mimetype };
  }

  async create(cmd: CreateReviewCommand): Promise<{ review: Review; verifiedPurchase: boolean }> {
    const fields = normalizeReview(cmd);
    const photos = [...new Set(cmd.photos ?? [])];
    if (photos.length > MAX_REVIEW_PHOTOS) throw new InvalidReviewError(`Máximo ${MAX_REVIEW_PHOTOS} fotos`, 'photos');
    const prefix = photoPrefix(cmd.tenantId, cmd.userId);
    // Exactamente una clave emitida por uploadPhoto: ".." se puede colar codificado (%2e%2e).
    if (photos.some((p) => !p.startsWith(prefix) || !PHOTO_FILE.test(p.slice(prefix.length)))) {
      throw new InvalidReviewError('Las fotos deben subirse antes con POST /me/reviews/photos', 'photos');
    }
    const product = await this.reviews.findProduct(this.db, cmd.tenantId, cmd.productId);
    if (!product) throw new CatalogProductNotFoundError(cmd.productId);

    const delivered = await this.orders.findDeliveredLines(cmd.tenantId, cmd.userId, [cmd.productId]);
    const reviewed = await this.reviews.reviewedBy(this.db, cmd.userId, cmd.productId);
    const line = delivered.find((l) => !reviewed.orderItemIds.includes(l.orderItemId));
    if (!line && (delivered.length > 0 || reviewed.hasUnverified)) throw new AlreadyReviewedError(cmd.productId, delivered.length > 0);

    const review: Review = {
      id: randomUUID(),
      productId: cmd.productId,
      userId: cmd.userId,
      orderItemId: line?.orderItemId ?? null,
      ...fields,
      status: 'pending',
      helpfulCount: 0,
      rejectionReason: null,
      moderatedBy: null,
      moderatedAt: null,
      createdAt: new Date(),
      photos,
    };
    return this.db.withTransaction(async (tx) => {
      if (!(await this.reviews.insert(tx, review))) throw new AlreadyReviewedError(cmd.productId, review.orderItemId !== null);
      await this.outbox.append(tx, [reviewEvent(cmd.tenantId, REVIEW_SUBMITTED, this.payload(review, product.name, product))]);
      return { review, verifiedPurchase: review.orderItemId !== null };
    });
  }

  async mine(tenantId: string, userId: string) {
    const rows = await this.reviews.listByUser(this.db, tenantId, userId);
    return rows.map(({ userId: _u, moderatedBy: _m, photos, ...r }) => ({ ...r, verifiedPurchase: r.orderItemId !== null, photoCount: photos.length }));
  }

  // ------------------------------------------------------------------ público

  async listPublic(tenantId: string, productId: string, filter: PublicReviewFilter): Promise<{ summary: ReviewSummary; reviews: PublicReview[] }> {
    if (!(await this.reviews.findProduct(this.db, tenantId, productId))) throw new CatalogProductNotFoundError(productId);
    const [summary, rows] = await Promise.all([this.reviews.summary(this.db, tenantId, productId), this.reviews.listPublic(this.db, tenantId, productId, filter)]);
    const names = await this.authorNames(tenantId, rows.map((r) => r.userId));
    return {
      summary,
      reviews: rows.map((r) => ({
        id: r.id,
        rating: r.rating,
        fitFeedback: r.fitFeedback,
        title: r.title,
        body: r.body,
        author: names.get(r.userId) ?? 'Cliente',
        verifiedPurchase: r.orderItemId !== null,
        photoCount: r.photos.length,
        helpfulCount: r.helpfulCount,
        createdAt: r.createdAt,
      })),
    };
  }

  /** Foto de una reseña. Público: solo aprobadas. Moderador (staff = true): cualquiera. */
  async photo(tenantId: string, reviewId: string, index: number, opts: { productId?: string; staff?: boolean } = {}): Promise<StoredObject> {
    const r = await this.reviews.findById(this.db, tenantId, reviewId);
    if (!r || (opts.productId && r.productId !== opts.productId) || (!opts.staff && r.status !== 'approved')) throw new ReviewNotFoundError(reviewId);
    const key = r.photos[index];
    const file = key ? await this.photos.get(key) : null;
    if (!file) throw new ReviewNotFoundError(reviewId);
    return file;
  }

  // ------------------------------------------------------------------ moderación

  async queue(tenantId: string, status: ReviewStatus, limit: number, offset: number): Promise<ModerationReview[]> {
    const rows = await this.reviews.listQueue(this.db, tenantId, status, limit, offset);
    return rows.map((r) => ({ ...r, verifiedPurchase: r.orderItemId !== null, flags: moderationFlags(r.title, r.body) }));
  }

  approve(tenantId: string, reviewId: string, moderatorId: string) {
    return this.moderate(tenantId, reviewId, moderatorId, 'approved', null);
  }

  reject(tenantId: string, reviewId: string, moderatorId: string, reason: string) {
    return this.moderate(tenantId, reviewId, moderatorId, 'rejected', normalizeRejectionReason(reason));
  }

  private async moderate(tenantId: string, reviewId: string, moderatorId: string, status: 'approved' | 'rejected', reason: string | null) {
    const peek = await this.reviews.findById(this.db, tenantId, reviewId);
    if (!peek) throw new ReviewNotFoundError(reviewId);
    return this.db.withTransaction(async (tx) => {
      // Primero el producto: serializa las moderaciones del mismo producto antes de leer las reseñas.
      const product = await this.reviews.findProduct(tx, tenantId, peek.productId, { forUpdate: true });
      if (!product) throw new CatalogProductNotFoundError(peek.productId);
      const review = await this.reviews.findById(tx, tenantId, reviewId, { forUpdate: true });
      if (!review) throw new ReviewNotFoundError(reviewId);
      if (review.status !== 'pending') throw new AlreadyModeratedError(reviewId, review.status);
      review.status = status;
      review.rejectionReason = reason;
      review.moderatedBy = moderatorId;
      review.moderatedAt = new Date();
      await this.reviews.saveModeration(tx, review);
      const rating = await this.reviews.recomputeRating(tx, review.productId);
      await this.outbox.append(tx, [reviewEvent(tenantId, status === 'approved' ? REVIEW_APPROVED : REVIEW_REJECTED, this.payload(review, product.name, rating))]);
      return { review: { ...review, verifiedPurchase: review.orderItemId !== null }, product: { id: product.id, ...rating } };
    });
  }

  // ------------------------------------------------------------------ preguntas y respuestas

  async ask(tenantId: string, userId: string, productId: string, body: unknown): Promise<Question> {
    const text = normalizeQuestionBody(body);
    if (!(await this.reviews.findProduct(this.db, tenantId, productId))) throw new CatalogProductNotFoundError(productId);
    const question: Question = {
      id: randomUUID(),
      productId,
      userId,
      body: text,
      status: 'pending',
      rejectionReason: null,
      moderatedBy: null,
      moderatedAt: null,
      createdAt: new Date(),
      answers: [],
    };
    await this.questions.insert(this.db, question);
    return question;
  }

  async listQuestions(tenantId: string, productId: string, limit: number, offset: number) {
    if (!(await this.reviews.findProduct(this.db, tenantId, productId))) throw new CatalogProductNotFoundError(productId);
    const rows = await this.questions.listPublished(this.db, tenantId, productId, limit, offset);
    return rows.map((q) => ({
      id: q.id,
      body: q.body,
      createdAt: q.createdAt,
      answers: q.answers.map((a) => ({ id: a.id, body: a.body, isOfficial: a.isOfficial, author: a.isOfficial ? 'Tienda' : 'Cliente', createdAt: a.createdAt })),
    }));
  }

  async questionQueue(tenantId: string, status: QuestionStatus, limit: number, offset: number) {
    const rows = await this.questions.listQueue(this.db, tenantId, status, limit, offset);
    return rows.map((q) => ({ ...q, flags: moderationFlags(q.body) }));
  }

  /** Publica sin responder (otra persona puede responder después). */
  publishQuestion(tenantId: string, questionId: string, moderatorId: string) {
    return this.moderateQuestion(tenantId, questionId, moderatorId, 'published', null);
  }

  rejectQuestion(tenantId: string, questionId: string, moderatorId: string, reason: string) {
    return this.moderateQuestion(tenantId, questionId, moderatorId, 'rejected', normalizeRejectionReason(reason));
  }

  /** Respuesta oficial de la tienda. Responder una pregunta pendiente la publica. */
  async answer(tenantId: string, questionId: string, staffId: string, body: unknown): Promise<Question> {
    const text = normalizeAnswerBody(body);
    return this.db.withTransaction(async (tx) => {
      const q = await this.questions.findById(tx, tenantId, questionId, { forUpdate: true });
      if (!q) throw new QuestionNotFoundError(questionId);
      if (q.status === 'rejected') throw new AlreadyModeratedError(questionId, q.status);
      const answer: Answer = { id: randomUUID(), questionId, userId: staffId, isOfficial: true, body: text, createdAt: new Date() };
      await this.questions.insertAnswer(tx, answer);
      if (q.status === 'pending') {
        q.status = 'published';
        q.moderatedBy = staffId;
        q.moderatedAt = answer.createdAt;
        await this.questions.saveModeration(tx, q);
      }
      const product = await this.reviews.findProduct(tx, tenantId, q.productId);
      await this.outbox.append(tx, [
        questionAnswered(tenantId, {
          questionId,
          answerId: answer.id,
          productId: q.productId,
          productName: product?.name ?? '',
          askedBy: q.userId,
          isOfficial: true,
        }),
      ]);
      return { ...q, answers: [...q.answers, answer] };
    });
  }

  private async moderateQuestion(tenantId: string, questionId: string, moderatorId: string, status: 'published' | 'rejected', reason: string | null): Promise<Question> {
    return this.db.withTransaction(async (tx) => {
      const q = await this.questions.findById(tx, tenantId, questionId, { forUpdate: true });
      if (!q) throw new QuestionNotFoundError(questionId);
      if (q.status !== 'pending') throw new AlreadyModeratedError(questionId, q.status);
      q.status = status;
      q.rejectionReason = reason;
      q.moderatedBy = moderatorId;
      q.moderatedAt = new Date();
      await this.questions.saveModeration(tx, q);
      return q;
    });
  }

  // ------------------------------------------------------------------ apoyo

  private payload(r: Review, productName: string, rating: { ratingAvg: string; ratingCount: number }) {
    return {
      reviewId: r.id,
      productId: r.productId,
      productName,
      userId: r.userId,
      rating: r.rating,
      verifiedPurchase: r.orderItemId !== null,
      status: r.status,
      rejectionReason: r.rejectionReason,
      ratingAvg: rating.ratingAvg,
      ratingCount: rating.ratingCount,
    };
  }

  /** "Ana P." por usuario (IAM). Un anonimizado o inexistente queda como "Cliente". */
  private async authorNames(tenantId: string, userIds: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(userIds)];
    const contacts = await Promise.all(unique.map((id) => this.iam.getContact(tenantId, id)));
    return new Map(unique.map((id, i) => [id, authorName(contacts[i]?.firstName, contacts[i]?.lastName)]));
  }
}
