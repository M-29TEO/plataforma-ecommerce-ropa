/**
 * Catálogo: reseñas con fotos y preguntas y respuestas (schema catalog).
 *
 *  1. Columnas de moderación en catalog.reviews y catalog.product_questions (cambio aprobado el
 *     2026-10-01): rejection_reason, moderated_by y moderated_at. El cliente tiene que poder ver
 *     por qué se rechazó su reseña o pregunta, y queda constancia de quién moderó y cuándo
 *     (todavía no hay un escritor de platform.audit_log).
 *  2. ux_reviews_unverified: una sola reseña SIN compra por usuario y producto. El UNIQUE
 *     (user_id, product_id, order_item_id) de 0001 no lo garantiza porque los NULL son distintos.
 *     Las reseñas con compra verificada siguen limitadas a una por línea del pedido.
 *  3. Índices: cola de moderación (pendientes por antigüedad), fotos por reseña y respuestas por
 *     pregunta.
 *  4. Permisos: catalog.reviews.moderate y catalog.questions.answer (moderar y responder preguntas).
 */
const PERMISSIONS = [
  ['catalog.reviews.moderate', 'Aprobar o rechazar reseñas de productos (con sus fotos)'],
  ['catalog.questions.answer', 'Publicar, rechazar y responder (respuesta oficial) preguntas de productos'],
];

exports.up = (pgm) => {
  const values = PERMISSIONS.map(([code, desc]) => `('${code}', '${desc.replace(/'/g, "''")}')`).join(',\n  ');
  pgm.sql(`
    ALTER TABLE catalog.reviews
      ADD COLUMN rejection_reason text,
      ADD COLUMN moderated_by uuid REFERENCES iam.users(id),
      ADD COLUMN moderated_at timestamptz;
    ALTER TABLE catalog.product_questions
      ADD COLUMN rejection_reason text,
      ADD COLUMN moderated_by uuid REFERENCES iam.users(id),
      ADD COLUMN moderated_at timestamptz;

    CREATE UNIQUE INDEX ux_reviews_unverified ON catalog.reviews (user_id, product_id) WHERE order_item_id IS NULL;
    CREATE INDEX ix_reviews_pending ON catalog.reviews (created_at) WHERE status = 'pending';
    CREATE INDEX ix_reviews_user ON catalog.reviews (user_id, created_at DESC);
    CREATE INDEX ix_questions_pending ON catalog.product_questions (created_at) WHERE status = 'pending';
    CREATE INDEX ix_review_media_review ON catalog.review_media (review_id);
    CREATE INDEX ix_answers_question ON catalog.product_answers (question_id, created_at);

    INSERT INTO iam.permissions (code, description) VALUES
      ${values}
    ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM iam.permissions WHERE code IN (${PERMISSIONS.map(([c]) => `'${c}'`).join(', ')});
    DROP INDEX IF EXISTS catalog.ix_answers_question;
    DROP INDEX IF EXISTS catalog.ix_review_media_review;
    DROP INDEX IF EXISTS catalog.ix_questions_pending;
    DROP INDEX IF EXISTS catalog.ix_reviews_user;
    DROP INDEX IF EXISTS catalog.ix_reviews_pending;
    DROP INDEX IF EXISTS catalog.ux_reviews_unverified;
    ALTER TABLE catalog.product_questions
      DROP COLUMN IF EXISTS moderated_at, DROP COLUMN IF EXISTS moderated_by, DROP COLUMN IF EXISTS rejection_reason;
    ALTER TABLE catalog.reviews
      DROP COLUMN IF EXISTS moderated_at, DROP COLUMN IF EXISTS moderated_by, DROP COLUMN IF EXISTS rejection_reason;
  `);
};
