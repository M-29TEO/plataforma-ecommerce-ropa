import { Injectable } from '@nestjs/common';

/**
 * A quién pertenecen los datos: un cliente registrado de un tenant. email y orderIds los aportan
 * IAM y Pedidos (hook resolve) ANTES de exportar o anonimizar, para los módulos que no conocen al
 * usuario: Facturación y Logística ubican sus filas por pedido; Notificaciones, por destinatario.
 */
export interface DataSubject {
  tenantId: string;
  userId: string;
  email: string | null;
  orderIds: string[];
}

/**
 * Derechos del titular (LOPDP, Ecuador: acceso/portabilidad y eliminación). Cada módulo que guarda
 * datos personales registra un contribuyente que exporta y anonimiza SOLO su propio schema, así el
 * orquestador (módulo privacy) no lee tablas ajenas ni importa a nadie.
 */
export abstract class PersonalDataContributor {
  /** Clave de la sección en el JSON exportado ('perfil', 'pedidos', 'direcciones'...). */
  abstract readonly section: string;
  /**
   * Orden de anonimización (menor primero). IAM va al final (100): los demás pueden necesitar el
   * email o el estado del usuario mientras anonimizan.
   */
  readonly order: number = 50;

  /** Datos que este módulo conoce del titular y que otros necesitan para ubicar los suyos. */
  async resolve(_subject: DataSubject): Promise<Partial<Pick<DataSubject, 'email' | 'orderIds'>>> {
    return {};
  }

  /** Datos del titular, legibles y sin secretos (ni hashes, ni tokens, ni claves). */
  abstract exportData(subject: DataSubject): Promise<unknown>;

  /**
   * Motivos que impiden anonimizar AHORA (pedido en curso, devolución abierta...): la cuenta se
   * podría necesitar para terminar la operación. Vacío = se puede.
   */
  async blockers(_subject: DataSubject): Promise<string[]> {
    return [];
  }

  /**
   * Borra o seudonimiza los datos personales. Corre dentro de la transacción ambiental del
   * orquestador (todo o nada). Lo que la ley obliga a conservar (comprobantes del SRI, 7 años;
   * registros contables de pagos) se conserva y se declara en `retained`.
   */
  abstract anonymize(subject: DataSubject): Promise<AnonymizationResult>;
}

export interface AnonymizationResult {
  /** Filas modificadas o borradas. */
  affected: number;
  /** Qué se conserva y por qué (se le informa al titular). */
  retained?: string[];
}

/** Registro global (DatabaseModule): cada módulo inscribe su contribuyente en onModuleInit. */
@Injectable()
export class PersonalDataRegistry {
  private readonly contributors = new Map<string, PersonalDataContributor>();

  register(contributor: PersonalDataContributor): void {
    if (this.contributors.has(contributor.section)) throw new Error(`Sección LOPDP duplicada: ${contributor.section}`);
    this.contributors.set(contributor.section, contributor);
  }

  all(): PersonalDataContributor[] {
    return [...this.contributors.values()].sort((a, b) => a.order - b.order || a.section.localeCompare(b.section));
  }
}
