import { Injectable, OnModuleInit } from '@nestjs/common';
import { AnonymizationResult, Database, DataSubject, PersonalDataContributor, PersonalDataRegistry } from '../../../shared-kernel';

interface DocumentRow {
  doc_type: string;
  number: string;
  access_key: string;
  issue_date: string;
  status: string;
  total: string;
  order_id: string | null;
  buyer_id_type: string;
  buyer_id: string;
  buyer_name: string;
  buyer_email: string | null;
  buyer_address: string | null;
}

/**
 * LOPDP en Facturación (schema billing). Exporta los comprobantes electrónicos (facturas 01 y notas
 * de crédito 04) de los pedidos del titular, con los datos de comprador tal como se emitieron.
 *
 * No anonimiza nada: el comprobante autorizado es un documento tributario que el SRI exige
 * conservar 7 años, y su XML firmado (con la clave de acceso) no se puede alterar. Se declara en
 * `retained`. No exporta las claves de los archivos (xml_key/ride_key) ni mensajes internos del SRI.
 */
@Injectable()
export class BillingPersonalDataContributor extends PersonalDataContributor implements OnModuleInit {
  readonly section = 'facturas';

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
    if (subject.orderIds.length === 0) return [];
    // Las notas de crédito también llevan order_id (el de la factura que modifican).
    const { rows } = await this.db.query<DocumentRow>(
      `SELECT d.doc_type, ep.establishment || '-' || ep.emission_point || '-' || lpad(d.sequential::text, 9, '0') AS number,
              d.access_key, d.issue_date, d.status, d.total::text, d.order_id,
              d.buyer_id_type, d.buyer_id, d.buyer_name, d.buyer_email::text, d.buyer_address
         FROM billing.electronic_documents d
         JOIN billing.emission_points ep ON ep.id = d.emission_point_id
        WHERE d.tenant_id = $1 AND d.order_id = ANY($2::uuid[])
        ORDER BY d.issue_date, d.created_at`,
      [subject.tenantId, subject.orderIds],
    );
    return rows.map((r) => ({
      docType: r.doc_type === '04' ? 'credit_note' : 'invoice',
      number: r.number,
      accessKey: r.access_key,
      issueDate: r.issue_date,
      status: r.status,
      total: r.total,
      orderId: r.order_id,
      buyer: { idType: r.buyer_id_type, idNumber: r.buyer_id, name: r.buyer_name, email: r.buyer_email, address: r.buyer_address },
    }));
  }

  /**
   * Un comprobante aún sin autorizar se reintenta y relee el pedido (infoAdicional): si se anonimiza
   * antes, el SRI recibiría datos seudónimos. Se espera a que quede autorizado o devuelto.
   */
  override async blockers(subject: DataSubject): Promise<string[]> {
    if (subject.orderIds.length === 0) return [];
    const { rows } = await this.db.query<{ access_key: string }>(
      `SELECT access_key FROM billing.electronic_documents
        WHERE tenant_id = $1 AND order_id = ANY($2::uuid[]) AND status IN ('pending','signed','sent','received')`,
      [subject.tenantId, subject.orderIds],
    );
    return rows.map((r) => `Comprobante ${r.access_key} en proceso con el SRI`);
  }

  async anonymize(_subject: DataSubject): Promise<AnonymizationResult> {
    return {
      affected: 0,
      retained: ['Comprobantes electrónicos (facturas y notas de crédito) con tus datos de comprador: el SRI exige conservarlos 7 años'],
    };
  }
}
