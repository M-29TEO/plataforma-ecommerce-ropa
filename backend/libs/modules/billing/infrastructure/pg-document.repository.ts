import { Injectable } from '@nestjs/common';
import { isUniqueViolation, Queryable } from '../../../shared-kernel';
import { DocumentFilter, DocumentPatch, DocumentRepository, EmissionPoint, NewDocument } from '../application/ports';
import { DocumentStatus, ElectronicDocument, ElectronicDocumentWithLines, SriMessage } from '../domain/electronic-document';
import { InvoiceLine, PaymentForm } from '../domain/invoice';

/** Índices únicos parciales: una factura vigente por pedido (1759000000007) y una nota de crédito por devolución (1759000000008). */
const ONE_INVOICE_PER_ORDER = 'ux_ed_order_invoice';
const ONE_CREDIT_NOTE_PER_RETURN = 'ux_ed_return_credit_note';
const NOT_CURRENT = "('voided', 'not_authorized')";

const COLUMNS = `d.id, d.tenant_id, d.doc_type, d.emission_point_id, ep.establishment, ep.emission_point, ep.address AS establishment_address,
  d.sequential, d.access_key, d.environment, d.issue_date, d.order_id, d.return_id, d.modified_document_id, d.buyer_id_type, d.buyer_id, d.buyer_name, d.buyer_email,
  d.buyer_address, d.subtotal_0, d.subtotal_taxed, d.discount_total, d.tax_total, d.total, d.payment_forms, d.status,
  d.authorization_number, d.authorized_at, d.xml_key, d.ride_key, d.sri_messages, d.attempts, d.next_retry_at, d.emailed_at, d.created_at`;
const FROM = 'billing.electronic_documents d JOIN billing.emission_points ep ON ep.id = d.emission_point_id';

interface DocumentRow {
  id: string;
  tenant_id: string;
  doc_type: string;
  emission_point_id: string;
  establishment: string;
  emission_point: string;
  establishment_address: string;
  sequential: string;
  access_key: string;
  environment: number;
  issue_date: string;
  order_id: string | null;
  return_id: string | null;
  modified_document_id: string | null;
  buyer_id_type: string;
  buyer_id: string;
  buyer_name: string;
  buyer_email: string | null;
  buyer_address: string | null;
  subtotal_0: string;
  subtotal_taxed: string;
  discount_total: string;
  tax_total: string;
  total: string;
  payment_forms: PaymentForm[];
  status: DocumentStatus;
  authorization_number: string | null;
  authorized_at: Date | null;
  xml_key: string | null;
  ride_key: string | null;
  sri_messages: SriMessage[] | null;
  attempts: number;
  next_retry_at: Date | null;
  emailed_at: Date | null;
  created_at: Date;
}

interface LineRow {
  document_id: string;
  main_code: string;
  aux_code: string | null;
  description: string;
  quantity: string;
  unit_price: string;
  discount: string;
  tax_code: string;
  tax_rate_code: string;
  tax_rate: string;
  tax_base: string;
  tax_amount: string;
  line_total: string;
}

function toDocument(r: DocumentRow): ElectronicDocument {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    docType: r.doc_type,
    emissionPointId: r.emission_point_id,
    establishment: r.establishment,
    emissionPoint: r.emission_point,
    establishmentAddress: r.establishment_address,
    sequential: Number(r.sequential),
    accessKey: r.access_key,
    environment: r.environment as 1 | 2,
    issueDate: r.issue_date,
    orderId: r.order_id,
    returnId: r.return_id,
    modifiedDocumentId: r.modified_document_id,
    buyer: { idType: r.buyer_id_type, idNumber: r.buyer_id, name: r.buyer_name, email: r.buyer_email, address: r.buyer_address },
    subtotal0: r.subtotal_0,
    subtotalTaxed: r.subtotal_taxed,
    discountTotal: r.discount_total,
    taxTotal: r.tax_total,
    total: r.total,
    paymentForms: r.payment_forms,
    status: r.status,
    authorizationNumber: r.authorization_number,
    authorizedAt: r.authorized_at,
    xmlKey: r.xml_key,
    rideKey: r.ride_key,
    sriMessages: r.sri_messages ?? [],
    attempts: r.attempts,
    nextRetryAt: r.next_retry_at,
    emailedAt: r.emailed_at,
    createdAt: r.created_at,
  };
}

function toLine(r: LineRow): InvoiceLine {
  return {
    mainCode: r.main_code,
    auxCode: r.aux_code,
    description: r.description,
    quantity: Number(r.quantity),
    unitPrice: Number(r.unit_price).toFixed(2),
    discount: r.discount,
    taxCode: r.tax_code,
    taxRateCode: r.tax_rate_code,
    taxRate: r.tax_rate,
    taxBase: r.tax_base,
    taxAmount: r.tax_amount,
    lineTotal: r.line_total,
  };
}

const PATCH_COLUMNS: Record<keyof DocumentPatch, string> = {
  status: 'status',
  authorizationNumber: 'authorization_number',
  authorizedAt: 'authorized_at',
  xmlKey: 'xml_key',
  rideKey: 'ride_key',
  sriMessages: 'sri_messages',
  attempts: 'attempts',
  nextRetryAt: 'next_retry_at',
  emailedAt: 'emailed_at',
};

@Injectable()
export class PgDocumentRepository extends DocumentRepository {
  async findEmissionPoint(q: Queryable, tenantId: string, establishment: string, emissionPoint: string): Promise<EmissionPoint | null> {
    const { rows } = await q.query<{ id: string; environment: number; address: string }>(
      `SELECT id, environment, address FROM billing.emission_points
        WHERE tenant_id = $1 AND establishment = $2 AND emission_point = $3 AND active`,
      [tenantId, establishment, emissionPoint],
    );
    return rows[0] ? { id: rows[0].id, environment: rows[0].environment as 1 | 2, address: rows[0].address } : null;
  }

  async nextSequential(q: Queryable, emissionPointId: string, docType: string): Promise<number | null> {
    const { rows } = await q.query<{ last_value: string }>(
      `UPDATE billing.sequences SET last_value = last_value + 1
        WHERE emission_point_id = $1 AND doc_type = $2
       RETURNING last_value`,
      [emissionPointId, docType],
    );
    return rows[0] ? Number(rows[0].last_value) : null;
  }

  async insert(q: Queryable, d: NewDocument, lines: InvoiceLine[]): Promise<string | null> {
    let id: string;
    try {
      const { rows } = await q.query<{ id: string }>(
        `INSERT INTO billing.electronic_documents
           (tenant_id, doc_type, emission_point_id, sequential, access_key, environment, issue_date, order_id,
            buyer_id_type, buyer_id, buyer_name, buyer_email, buyer_address, subtotal_0, subtotal_taxed, discount_total,
            tax_total, total, payment_forms, status, next_retry_at, return_id, modified_document_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb, 'pending', $20, $21, $22)
         RETURNING id`,
        [
          d.tenantId, d.docType, d.emissionPointId, d.sequential, d.accessKey, d.environment, d.issueDate, d.orderId,
          d.buyer.idType, d.buyer.idNumber, d.buyer.name, d.buyer.email, d.buyer.address, d.subtotal0, d.subtotalTaxed,
          d.discountTotal, d.taxTotal, d.total, JSON.stringify(d.paymentForms), d.nextRetryAt, d.returnId ?? null,
          d.modifiedDocumentId ?? null,
        ],
      );
      id = rows[0].id;
    } catch (error) {
      if (isUniqueViolation(error, ONE_INVOICE_PER_ORDER) || isUniqueViolation(error, ONE_CREDIT_NOTE_PER_RETURN)) return null;
      throw error;
    }
    const values: unknown[] = [];
    const tuples = lines.map((l, i) => {
      const o = i * 12;
      values.push(id, l.mainCode, l.auxCode, l.description, l.quantity, l.unitPrice, l.discount, l.taxCode, l.taxRateCode, l.taxRate, l.taxBase, l.taxAmount);
      return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}, $${o + 8}, $${o + 9}, $${o + 10}, $${o + 11}, $${o + 12}, $${o + 11}::numeric + $${o + 12}::numeric)`;
    });
    await q.query(
      `INSERT INTO billing.electronic_document_lines
         (document_id, main_code, aux_code, description, quantity, unit_price, discount, tax_code, tax_rate_code, tax_rate,
          tax_base, tax_amount, line_total)
       VALUES ${tuples.join(', ')}`,
      values,
    );
    return id;
  }

  async findByOrder(q: Queryable, tenantId: string, orderId: string, docType: string): Promise<ElectronicDocument | null> {
    const { rows } = await q.query<DocumentRow>(
      `SELECT ${COLUMNS} FROM ${FROM} WHERE d.tenant_id = $1 AND d.order_id = $2 AND d.doc_type = $3 ORDER BY d.created_at LIMIT 1`,
      [tenantId, orderId, docType],
    );
    return rows[0] ? toDocument(rows[0]) : null;
  }

  async findCurrentInvoice(q: Queryable, tenantId: string, orderId: string): Promise<ElectronicDocument | null> {
    const { rows } = await q.query<DocumentRow>(
      `SELECT ${COLUMNS} FROM ${FROM}
        WHERE d.tenant_id = $1 AND d.order_id = $2 AND d.doc_type = '01' AND d.status NOT IN ${NOT_CURRENT}
        ORDER BY d.created_at DESC LIMIT 1`,
      [tenantId, orderId],
    );
    return rows[0] ? toDocument(rows[0]) : null;
  }

  async findCreditNoteByReturn(q: Queryable, tenantId: string, returnId: string): Promise<ElectronicDocument | null> {
    const { rows } = await q.query<DocumentRow>(
      `SELECT ${COLUMNS} FROM ${FROM}
        WHERE d.tenant_id = $1 AND d.return_id = $2 AND d.doc_type = '04' AND d.status NOT IN ${NOT_CURRENT}
        ORDER BY d.created_at DESC LIMIT 1`,
      [tenantId, returnId],
    );
    return rows[0] ? toDocument(rows[0]) : null;
  }

  async creditedTotal(q: Queryable, invoiceId: string): Promise<string> {
    const { rows } = await q.query<{ total: string }>(
      `SELECT COALESCE(sum(total), 0)::numeric(12,2)::text AS total FROM billing.electronic_documents
        WHERE modified_document_id = $1 AND doc_type = '04' AND status NOT IN ${NOT_CURRENT}`,
      [invoiceId],
    );
    return rows[0].total;
  }

  async findById(q: Queryable, tenantId: string, id: string): Promise<ElectronicDocumentWithLines | null> {
    const { rows } = await q.query<DocumentRow>(`SELECT ${COLUMNS} FROM ${FROM} WHERE d.tenant_id = $1 AND d.id = $2`, [tenantId, id]);
    if (!rows[0]) return null;
    const [withLines] = await this.attachLines(q, [toDocument(rows[0])]);
    return withLines;
  }

  async list(q: Queryable, tenantId: string, f: DocumentFilter): Promise<ElectronicDocument[]> {
    const { rows } = await q.query<DocumentRow>(
      `SELECT ${COLUMNS} FROM ${FROM}
        WHERE d.tenant_id = $1 AND ($2::uuid IS NULL OR d.order_id = $2) AND ($3::text[] IS NULL OR d.status = ANY($3))
          AND ($6::uuid IS NULL OR d.return_id = $6) AND ($7::text IS NULL OR d.doc_type = $7)
        ORDER BY d.created_at DESC, d.sequential DESC
        LIMIT $4 OFFSET $5`,
      [tenantId, f.orderId ?? null, f.statuses?.length ? f.statuses : null, f.limit, f.offset, f.returnId ?? null, f.docType ?? null],
    );
    return rows.map(toDocument);
  }

  async claimDue(q: Queryable, now: Date, leaseSeconds: number, limit: number, tenantId: string | null = null): Promise<ElectronicDocumentWithLines[]> {
    // ix_ed_retry cubre los estados con trabajo pendiente con el SRI; los autorizados sin email
    // son pocos (next_retry_at se limpia al enviarlo o al agotar los intentos).
    const { rows } = await q.query<{ id: string }>(
      `UPDATE billing.electronic_documents
          SET next_retry_at = $1::timestamptz + make_interval(secs => $2)
        WHERE id IN (
          SELECT id FROM billing.electronic_documents
           WHERE next_retry_at <= $1 AND ($4::uuid IS NULL OR tenant_id = $4)
             AND (status IN ('pending', 'signed', 'sent', 'received') OR (status = 'authorized' AND emailed_at IS NULL))
           ORDER BY next_retry_at
           LIMIT $3
           FOR UPDATE SKIP LOCKED)
       RETURNING id`,
      [now, leaseSeconds, limit, tenantId],
    );
    if (!rows.length) return [];
    const docs = await q.query<DocumentRow>(`SELECT ${COLUMNS} FROM ${FROM} WHERE d.id = ANY($1::uuid[]) ORDER BY d.created_at`, [
      rows.map((r) => r.id),
    ]);
    return this.attachLines(q, docs.rows.map(toDocument));
  }

  async findState(q: Queryable, id: string): Promise<{ status: DocumentStatus; attempts: number } | null> {
    const { rows } = await q.query<{ status: DocumentStatus; attempts: number }>('SELECT status, attempts FROM billing.electronic_documents WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  async update(q: Queryable, id: string, expectedStatus: DocumentStatus, patch: DocumentPatch): Promise<boolean> {
    // Las fechas van tal cual (pg las serializa) y sri_messages como jsonb.
    const sets: string[] = [];
    const values: unknown[] = [id, expectedStatus];
    for (const [key, column] of Object.entries(PATCH_COLUMNS) as [keyof DocumentPatch, string][]) {
      const value = patch[key];
      if (value === undefined) continue;
      values.push(key === 'sriMessages' ? JSON.stringify(value) : value);
      sets.push(`${column} = $${values.length}${key === 'sriMessages' ? '::jsonb' : ''}`);
    }
    if (!sets.length) return true;
    const res = await q.query(`UPDATE billing.electronic_documents SET ${sets.join(', ')} WHERE id = $1 AND status = $2`, values);
    return res.rowCount === 1;
  }

  private async attachLines(q: Queryable, docs: ElectronicDocument[]): Promise<ElectronicDocumentWithLines[]> {
    if (!docs.length) return [];
    const { rows } = await q.query<LineRow>(
      `SELECT document_id, main_code, aux_code, description, quantity, unit_price, discount, tax_code, tax_rate_code, tax_rate,
              tax_base, tax_amount, line_total
         FROM billing.electronic_document_lines WHERE document_id = ANY($1::uuid[]) ORDER BY id`,
      [docs.map((d) => d.id)],
    );
    return docs.map((d) => ({ ...d, lines: rows.filter((r) => r.document_id === d.id).map(toLine) }));
  }
}
