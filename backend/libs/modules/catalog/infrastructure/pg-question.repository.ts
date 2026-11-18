import { Injectable } from '@nestjs/common';
import { Queryable } from '../../../shared-kernel';
import { QuestionRepository } from '../application/review-ports';
import { Answer, Question, QuestionStatus } from '../domain/review';

interface QuestionRow {
  id: string;
  product_id: string;
  user_id: string | null;
  body: string;
  status: QuestionStatus;
  rejection_reason: string | null;
  moderated_by: string | null;
  moderated_at: Date | null;
  created_at: Date;
  answers: Array<{ id: string; questionId: string; userId: string; isOfficial: boolean; body: string; createdAt: string }> | null;
  product_name?: string;
}

const COLUMNS = `q.id, q.product_id, q.user_id, q.body, q.status, q.rejection_reason, q.moderated_by, q.moderated_at, q.created_at,
  (SELECT json_agg(json_build_object('id', a.id, 'questionId', a.question_id, 'userId', a.user_id, 'isOfficial', a.is_official,
                                     'body', a.body, 'createdAt', a.created_at) ORDER BY a.is_official DESC, a.created_at)
     FROM catalog.product_answers a WHERE a.question_id = q.id) AS answers`;

const toQuestion = (r: QuestionRow): Question => ({
  id: r.id,
  productId: r.product_id,
  userId: r.user_id,
  body: r.body,
  status: r.status,
  rejectionReason: r.rejection_reason,
  moderatedBy: r.moderated_by,
  moderatedAt: r.moderated_at,
  createdAt: r.created_at,
  answers: (r.answers ?? []).map((a): Answer => ({ ...a, createdAt: new Date(a.createdAt) })),
});

@Injectable()
export class PgQuestionRepository extends QuestionRepository {
  async insert(q: Queryable, x: Question): Promise<void> {
    await q.query(`INSERT INTO catalog.product_questions (id, product_id, user_id, body, status, created_at) VALUES ($1, $2, $3, $4, $5, $6)`, [
      x.id,
      x.productId,
      x.userId,
      x.body,
      x.status,
      x.createdAt,
    ]);
  }

  async findById(q: Queryable, tenantId: string, id: string, opts: { forUpdate?: boolean } = {}): Promise<Question | null> {
    const { rows } = await q.query<QuestionRow>(
      `SELECT ${COLUMNS} FROM catalog.product_questions q JOIN catalog.products p ON p.id = q.product_id
        WHERE p.tenant_id = $1 AND q.id = $2${opts.forUpdate ? ' FOR UPDATE OF q' : ''}`,
      [tenantId, id],
    );
    return rows[0] ? toQuestion(rows[0]) : null;
  }

  async saveModeration(q: Queryable, x: Question): Promise<void> {
    await q.query(`UPDATE catalog.product_questions SET status = $2, rejection_reason = $3, moderated_by = $4, moderated_at = $5 WHERE id = $1`, [
      x.id,
      x.status,
      x.rejectionReason,
      x.moderatedBy,
      x.moderatedAt,
    ]);
  }

  async insertAnswer(q: Queryable, a: Answer): Promise<void> {
    await q.query(`INSERT INTO catalog.product_answers (id, question_id, user_id, is_official, body, created_at) VALUES ($1, $2, $3, $4, $5, $6)`, [
      a.id,
      a.questionId,
      a.userId,
      a.isOfficial,
      a.body,
      a.createdAt,
    ]);
  }

  async listPublished(q: Queryable, tenantId: string, productId: string, limit: number, offset: number): Promise<Question[]> {
    const { rows } = await q.query<QuestionRow>(
      `SELECT ${COLUMNS} FROM catalog.product_questions q JOIN catalog.products p ON p.id = q.product_id
        WHERE p.tenant_id = $1 AND q.product_id = $2 AND q.status = 'published'
        ORDER BY q.created_at DESC, q.id LIMIT $3 OFFSET $4`,
      [tenantId, productId, limit, offset],
    );
    return rows.map(toQuestion);
  }

  async listQueue(q: Queryable, tenantId: string, status: QuestionStatus, limit: number, offset: number): Promise<Array<Question & { productName: string }>> {
    const { rows } = await q.query<QuestionRow>(
      `SELECT ${COLUMNS}, p.name AS product_name FROM catalog.product_questions q JOIN catalog.products p ON p.id = q.product_id
        WHERE p.tenant_id = $1 AND q.status = $2
        ORDER BY ${status === 'pending' ? 'q.created_at ASC' : 'q.moderated_at DESC NULLS LAST'}, q.id LIMIT $3 OFFSET $4`,
      [tenantId, status, limit, offset],
    );
    return rows.map((r) => ({ ...toQuestion(r), productName: r.product_name! }));
  }
}
