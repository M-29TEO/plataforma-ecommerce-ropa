import { Injectable } from '@nestjs/common';
import {
  AuditLog,
  AuthUser,
  ConflictError,
  Database,
  DataSubject,
  ForbiddenError,
  PersonalDataRegistry,
} from '../../../shared-kernel';
import { IamApi } from '../../iam';

export interface PersonalDataExport {
  generadoEn: string;
  titular: { tenantId: string; userId: string };
  /** Una sección por módulo ('cuenta', 'pedidos', 'direcciones'...). */
  secciones: Record<string, unknown>;
  aviso: string;
}

export interface AnonymizationReport {
  anonimizadoEn: string;
  secciones: { seccion: string; filas: number }[];
  /** Lo que la ley obliga a conservar, y por qué. */
  conservado: string[];
}

/**
 * Derechos LOPDP del titular (Ley Orgánica de Protección de Datos Personales, Ecuador):
 *  - acceso y portabilidad: exportar en JSON todo lo que la plataforma guarda de él;
 *  - eliminación: anonimizar la cuenta, salvo lo que otra ley obliga a conservar (comprobantes
 *    del SRI, registros contables), que queda sin datos de contacto y se declara en el informe.
 *
 * Orquestador: no lee tablas ajenas. Cada módulo registra en el PersonalDataRegistry un
 * contribuyente que exporta y anonimiza SU schema; aquí solo se componen, en una transacción.
 */
@Injectable()
export class PrivacyService {
  constructor(
    private readonly db: Database,
    private readonly registry: PersonalDataRegistry,
    private readonly iam: IamApi,
    private readonly audit: AuditLog,
  ) {}

  async exportData(user: AuthUser): Promise<PersonalDataExport> {
    const subject = await this.resolve(user);
    const secciones: Record<string, unknown> = {};
    for (const c of this.registry.all()) secciones[c.section] = await c.exportData(subject);
    return {
      generadoEn: new Date().toISOString(),
      titular: { tenantId: user.tenantId, userId: user.id },
      secciones,
      aviso:
        'Copia de tus datos personales (LOPDP, derecho de acceso y portabilidad). No incluye contraseñas, ' +
        'secretos del 2FA ni tokens. Para corregir un dato, edítalo en tu cuenta; para eliminarla, usa ' +
        'POST /v1/me/privacy/anonymize.',
    };
  }

  /**
   * 403 si no es una cuenta de cliente (staff y motorizados se dan de baja por el administrador:
   * sus acciones quedan en la auditoría). 422/423 si la contraseña no es correcta. 409
   * ACCOUNT_HAS_OPEN_OPERATIONS si hay pedidos, envíos o devoluciones en curso.
   */
  async anonymize(user: AuthUser, password: string, ip: string | null, requestId: string | null): Promise<AnonymizationReport> {
    if (user.type !== 'customer') throw new ForbiddenError('CUSTOMERS_ONLY', 'Solo las cuentas de cliente se anonimizan desde la tienda');
    await this.iam.reauthenticate(user.tenantId, user.id, password);
    const subject = await this.resolve(user);
    const contributors = this.registry.all();

    const blockers = (await Promise.all(contributors.map((c) => c.blockers(subject)))).flat();
    if (blockers.length > 0) {
      throw new ConflictError('ACCOUNT_HAS_OPEN_OPERATIONS', 'Termina o cancela tus operaciones en curso antes de eliminar la cuenta', { blockers });
    }

    return this.db.withTransaction(async (tx) => {
      const secciones: AnonymizationReport['secciones'] = [];
      const conservado: string[] = [];
      // En serie: comparten la conexión de la transacción ambiental. IAM va al final (order 100).
      for (const c of contributors) {
        const r = await c.anonymize(subject);
        secciones.push({ seccion: c.section, filas: r.affected });
        conservado.push(...(r.retained ?? []));
      }
      const report = { anonimizadoEn: new Date().toISOString(), secciones, conservado };
      // En la MISMA transacción: si la anonimización se revierte, su registro también.
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.id,
        actorType: user.type,
        actorIp: ip,
        action: 'privacy.account.anonymized',
        entityType: 'user',
        entityId: user.id,
        after: { secciones },
        requestId,
      });
      return report;
    });
  }

  /** email y orderIds los aportan IAM y Pedidos para los módulos que no conocen al usuario. */
  private async resolve(user: AuthUser): Promise<DataSubject> {
    const subject: DataSubject = { tenantId: user.tenantId, userId: user.id, email: null, orderIds: [] };
    for (const c of this.registry.all()) Object.assign(subject, await c.resolve(subject));
    return subject;
  }
}
