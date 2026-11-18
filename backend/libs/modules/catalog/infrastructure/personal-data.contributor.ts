import { Injectable, OnModuleInit } from '@nestjs/common';
import { AnonymizationResult, Database, DataSubject, PersonalDataContributor, PersonalDataRegistry } from '../../../shared-kernel';

interface ReviewRow {
  product_id: string;
  rating: number;
  fit_feedback: string | null;
  title: string | null;
  body: string | null;
  status: string;
  created_at: Date;
  photo_count: number;
}

interface QuestionRow {
  product_id: string;
  body: string;
  status: string;
  created_at: Date;
}

/**
 * LOPDP en Reseñas y preguntas (schema catalog). reviews y product_questions no tienen tenant_id:
 * el tenant se toma del producto (catalog.products), como en los repositorios.
 *
 * Exporta sus reseñas (calificación, ajuste, texto, estado, cantidad de fotos; no las claves de
 * almacenamiento) y sus preguntas. Anonimiza: borra sus reseñas con sus fotos (review_media) y
 * recalcula rating_avg/rating_count de los productos afectados; sus preguntas quedan como Q&A
 * anónimo (user_id NULL), porque las respuestas de la tienda sirven a otros compradores.
 * Los archivos de las fotos quedan en el almacenamiento de objetos: ObjectStorage no tiene delete.
 */
@Injectable()
export class CatalogPersonalDataContributor extends PersonalDataContributor implements OnModuleInit {
  readonly section = 'resenas';

  constructor(
    private readonly registry: PersonalDataRegistry,
    private readonly db: Database,
  ) {
    super();
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  async exportData(subject: DataSubject): Promise<unknown> {
    const params = [subject.tenantId, subject.userId];
    const { rows: reviews } = await this.db.query<ReviewRow>(
      `SELECT r.product_id, r.rating, r.fit_feedback, r.title, r.body, r.status, r.created_at,
              (SELECT count(*)::int FROM catalog.review_media m WHERE m.review_id = r.id) AS photo_count
         FROM catalog.reviews r JOIN catalog.products p ON p.id = r.product_id
        WHERE p.tenant_id = $1 AND r.user_id = $2
        ORDER BY r.created_at`,
      params,
    );
    const { rows: questions } = await this.db.query<QuestionRow>(
      `SELECT q.product_id, q.body, q.status, q.created_at
         FROM catalog.product_questions q JOIN catalog.products p ON p.id = q.product_id
        WHERE p.tenant_id = $1 AND q.user_id = $2
        ORDER BY q.created_at`,
      params,
    );
    return {
      reviews: reviews.map((r) => ({
        productId: r.product_id,
        rating: r.rating,
        fitFeedback: r.fit_feedback,
        title: r.title,
        body: r.body,
        status: r.status,
        photoCount: r.photo_count,
        createdAt: r.created_at.toISOString(),
      })),
      questions: questions.map((q) => ({ productId: q.product_id, body: q.body, status: q.status, createdAt: q.created_at.toISOString() })),
    };
  }

  async anonymize(subject: DataSubject): Promise<AnonymizationResult> {
    const params = [subject.tenantId, subject.userId];
    // review_media tiene ON DELETE CASCADE, pero se borra explícito para contar las fotos.
    const media = await this.db.query(
      `DELETE FROM catalog.review_media m
        USING catalog.reviews r, catalog.products p
        WHERE m.review_id = r.id AND p.id = r.product_id AND p.tenant_id = $1 AND r.user_id = $2`,
      params,
    );
    const reviews = await this.db.query<{ product_id: string; status: string }>(
      `DELETE FROM catalog.reviews r
        USING catalog.products p
        WHERE p.id = r.product_id AND p.tenant_id = $1 AND r.user_id = $2
        RETURNING r.product_id, r.status`,
      params,
    );
    // Solo las aprobadas cuentan en el promedio (mismo cálculo que PgReviewRepository.recomputeRating).
    const productIds = [...new Set(reviews.rows.filter((r) => r.status === 'approved').map((r) => r.product_id))];
    if (productIds.length > 0) {
      await this.db.query(
        `UPDATE catalog.products p
            SET rating_avg = s.avg, rating_count = s.count
           FROM (SELECT ids.id,
                        COALESCE(round(avg(r.rating), 2), 0) AS avg,
                        count(r.id)::int AS count
                   FROM unnest($1::uuid[]) AS ids(id)
                   LEFT JOIN catalog.reviews r ON r.product_id = ids.id AND r.status = 'approved'
                  GROUP BY ids.id) s
          WHERE p.id = s.id`,
        [productIds],
      );
    }
    const questions = await this.db.query(
      `UPDATE catalog.product_questions q SET user_id = NULL
         FROM catalog.products p
        WHERE p.id = q.product_id AND p.tenant_id = $1 AND q.user_id = $2`,
      params,
    );
    return {
      affected: (media.rowCount ?? 0) + (reviews.rowCount ?? 0) + (questions.rowCount ?? 0),
      retained: ['Tus preguntas de producto y sus respuestas, sin vínculo a tu cuenta (preguntas y respuestas anónimas)'],
    };
  }
}
