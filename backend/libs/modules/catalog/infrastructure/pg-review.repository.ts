import { Injectable } from '@nestjs/common';
import { isUniqueViolation, Queryable } from '../../../shared-kernel';
import { PublicReviewFilter, ReviewableProduct, ReviewRepository, ReviewSummary } from '../application/review-ports';
import { FitFeedback, Review, ReviewStatus } from '../domain/review';

interface ReviewRow {
  id: string;
  product_id: string;
  user_id: string;
  order_item_id: string | null;
  rating: number;
  fit_feedback: FitFeedback | null;
  title: string | null;
  body: string | null;
  status: ReviewStatus;
  helpful_count: number;
  rejection_reason: string | null;
  moderated_by: string | null;
  moderated_at: Date | null;
  created_at: Date;
  photos: string[] | null;
  product_name?: string;
}

/** Columnas de r (catalog.reviews) con sus fotos (orden estable por clave: review_media no tiene columna de orden). */
const COLUMNS = `r.id, r.product_id, r.user_id, r.order_item_id, r.rating, r.fit_feedback, r.title, r.body, r.status,
  r.helpful_count, r.rejection_reason, r.moderated_by, r.moderated_at, r.created_at,
  (SELECT array_agg(m.storage_key ORDER BY m.storage_key) FROM catalog.review_media m WHERE m.review_id = r.id) AS photos`;

const toReview = (r: ReviewRow): Review => ({
  id: r.id,
  productId: r.product_id,
  userId: r.user_id,
  orderItemId: r.order_item_id,
  rating: r.rating,
  fitFeedback: r.fit_feedback,
  title: r.title,
  body: r.body,
  status: r.status,
  helpfulCount: r.helpful_count,
  rejectionReason: r.rejection_reason,
  moderatedBy: r.moderated_by,
  moderatedAt: r.moderated_at,
  createdAt: r.created_at,
  photos: r.photos ?? [],
});

const SORTS: Record<PublicReviewFilter['sort'], string> = {
  recent: 'r.created_at DESC, r.id',
  rating_desc: 'r.rating DESC, r.created_at DESC, r.id',
  rating_asc: 'r.rating ASC, r.created_at DESC, r.id',
  helpful: 'r.helpful_count DESC, r.created_at DESC, r.id',
};

@Injectable()
export class PgReviewRepository extends ReviewRepository {
  async findProduct(q: Queryable, tenantId: string, productId: string, opts: { forUpdate?: boolean } = {}): Promise<ReviewableProduct | null> {
    const { rows } = await q.query<{ id: string; name: string; rating_avg: string; rating_count: number }>(
      `SELECT id, name, rating_avg::text, rating_count FROM catalog.products
        WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL${opts.forUpdate ? ' FOR UPDATE' : ''}`,
      [tenantId, productId],
    );
    const r = rows[0];
    return r ? { id: r.id, name: r.name, ratingAvg: r.rating_avg, ratingCount: r.rating_count } : null;
  }

  async reviewedBy(q: Queryable, userId: string, productId: string): Promise<{ orderItemIds: string[]; hasUnverified: boolean }> {
    const { rows } = await q.query<{ order_item_id: string | null }>(`SELECT order_item_id FROM catalog.reviews WHERE user_id = $1 AND product_id = $2`, [
      userId,
      productId,
    ]);
    return {
      orderItemIds: rows.map((r) => r.order_item_id).filter((id): id is string => id !== null),
      hasUnverified: rows.some((r) => r.order_item_id === null),
    };
  }

  async insert(q: Queryable, r: Review): Promise<boolean> {
    try {
      await q.query(
        `INSERT INTO catalog.reviews (id, product_id, user_id, order_item_id, rating, fit_feedback, title, body, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [r.id, r.productId, r.userId, r.orderItemId, r.rating, r.fitFeedback, r.title, r.body, r.status, r.createdAt],
      );
    } catch (e) {
      if (isUniqueViolation(e)) return false;
      throw e;
    }
    if (r.photos.length > 0) {
      await q.query(`INSERT INTO catalog.review_media (review_id, storage_key) SELECT $1, unnest($2::text[])`, [r.id, r.photos]);
    }
    return true;
  }

  async findById(q: Queryable, tenantId: string, id: string, opts: { forUpdate?: boolean } = {}): Promise<Review | null> {
    const { rows } = await q.query<ReviewRow>(
      `SELECT ${COLUMNS} FROM catalog.reviews r JOIN catalog.products p ON p.id = r.product_id
        WHERE p.tenant_id = $1 AND r.id = $2${opts.forUpdate ? ' FOR UPDATE OF r' : ''}`,
      [tenantId, id],
    );
    return rows[0] ? toReview(rows[0]) : null;
  }

  async saveModeration(q: Queryable, r: Review): Promise<void> {
    await q.query(`UPDATE catalog.reviews SET status = $2, rejection_reason = $3, moderated_by = $4, moderated_at = $5 WHERE id = $1`, [
      r.id,
      r.status,
      r.rejectionReason,
      r.moderatedBy,
      r.moderatedAt,
    ]);
  }

  async recomputeRating(q: Queryable, productId: string): Promise<{ ratingAvg: string; ratingCount: number }> {
    const { rows } = await q.query<{ rating_avg: string; rating_count: number }>(
      `UPDATE catalog.products p
          SET rating_avg = s.avg, rating_count = s.count
         FROM (SELECT COALESCE(round(avg(rating), 2), 0) AS avg, count(*)::int AS count
                 FROM catalog.reviews WHERE product_id = $1 AND status = 'approved') s
        WHERE p.id = $1
        RETURNING p.rating_avg::text, p.rating_count`,
      [productId],
    );
    return { ratingAvg: rows[0].rating_avg, ratingCount: rows[0].rating_count };
  }

  async listPublic(q: Queryable, tenantId: string, productId: string, f: PublicReviewFilter): Promise<Review[]> {
    const where = [`p.tenant_id = $1`, `r.product_id = $2`, `r.status = 'approved'`];
    const values: unknown[] = [tenantId, productId];
    if (f.rating) where.push(`r.rating = $${values.push(f.rating)}`);
    if (f.withPhotos) where.push(`EXISTS (SELECT 1 FROM catalog.review_media m WHERE m.review_id = r.id)`);
    if (f.verifiedOnly) where.push(`r.order_item_id IS NOT NULL`);
    const limit = values.push(f.limit);
    const offset = values.push(f.offset);
    const { rows } = await q.query<ReviewRow>(
      `SELECT ${COLUMNS} FROM catalog.reviews r JOIN catalog.products p ON p.id = r.product_id
        WHERE ${where.join(' AND ')} ORDER BY ${SORTS[f.sort]} LIMIT $${limit} OFFSET $${offset}`,
      values,
    );
    return rows.map(toReview);
  }

  async summary(q: Queryable, tenantId: string, productId: string): Promise<ReviewSummary> {
    const { rows } = await q.query<{
      avg: string;
      count: number;
      r1: number;
      r2: number;
      r3: number;
      r4: number;
      r5: number;
      small: number;
      fits: number;
      large: number;
      with_photos: number;
      verified: number;
    }>(
      `SELECT COALESCE(round(avg(r.rating), 2), 0)::numeric(3,2)::text AS avg, count(*)::int AS count,
              count(*) FILTER (WHERE r.rating = 1)::int AS r1, count(*) FILTER (WHERE r.rating = 2)::int AS r2,
              count(*) FILTER (WHERE r.rating = 3)::int AS r3, count(*) FILTER (WHERE r.rating = 4)::int AS r4,
              count(*) FILTER (WHERE r.rating = 5)::int AS r5,
              count(*) FILTER (WHERE r.fit_feedback = 'small')::int AS small,
              count(*) FILTER (WHERE r.fit_feedback = 'true')::int AS fits,
              count(*) FILTER (WHERE r.fit_feedback = 'large')::int AS large,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM catalog.review_media m WHERE m.review_id = r.id))::int AS with_photos,
              count(*) FILTER (WHERE r.order_item_id IS NOT NULL)::int AS verified
         FROM catalog.reviews r JOIN catalog.products p ON p.id = r.product_id
        WHERE p.tenant_id = $1 AND r.product_id = $2 AND r.status = 'approved'`,
      [tenantId, productId],
    );
    const s = rows[0];
    return {
      ratingAvg: s.avg,
      ratingCount: s.count,
      distribution: { '1': s.r1, '2': s.r2, '3': s.r3, '4': s.r4, '5': s.r5 },
      fit: { small: s.small, true: s.fits, large: s.large },
      withPhotos: s.with_photos,
      verified: s.verified,
    };
  }

  async listQueue(q: Queryable, tenantId: string, status: ReviewStatus, limit: number, offset: number): Promise<Array<Review & { productName: string }>> {
    const { rows } = await q.query<ReviewRow>(
      `SELECT ${COLUMNS}, p.name AS product_name FROM catalog.reviews r JOIN catalog.products p ON p.id = r.product_id
        WHERE p.tenant_id = $1 AND r.status = $2
        ORDER BY ${status === 'pending' ? 'r.created_at ASC' : 'r.moderated_at DESC NULLS LAST'}, r.id LIMIT $3 OFFSET $4`,
      [tenantId, status, limit, offset],
    );
    return rows.map((r) => ({ ...toReview(r), productName: r.product_name! }));
  }

  async listByUser(q: Queryable, tenantId: string, userId: string): Promise<Array<Review & { productName: string }>> {
    const { rows } = await q.query<ReviewRow>(
      `SELECT ${COLUMNS}, p.name AS product_name FROM catalog.reviews r JOIN catalog.products p ON p.id = r.product_id
        WHERE p.tenant_id = $1 AND r.user_id = $2 ORDER BY r.created_at DESC`,
      [tenantId, userId],
    );
    return rows.map((r) => ({ ...toReview(r), productName: r.product_name! }));
  }
}
