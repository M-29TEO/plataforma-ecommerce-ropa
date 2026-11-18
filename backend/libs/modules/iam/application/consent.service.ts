import { Injectable } from '@nestjs/common';
import { Database } from '../../../shared-kernel';
import { assertRevocable, ConsentPurpose, ConsentState, currentConsents } from '../domain/consent';
import { ConsentRepository, UserDirectory } from './ports';

export interface ConsentChange {
  purpose: ConsentPurpose;
  granted: boolean;
}

/** Consentimientos LOPDP: historial de solo inserción; el estado vigente es la fila más reciente. */
@Injectable()
export class ConsentService {
  constructor(
    private readonly db: Database,
    private readonly consents: ConsentRepository,
    private readonly users: UserDirectory,
  ) {}

  async listForUser(userId: string): Promise<ConsentState[]> {
    return currentConsents(await this.consents.listByUser(this.db, userId));
  }

  /**
   * Registra cada cambio como una fila nueva (con la versión de la política y la IP) y devuelve el
   * estado. Términos y privacidad no se revocan aquí (CONSENT_NOT_REVOCABLE): eso es pedir la supresión.
   */
  async record(userId: string, changes: ConsentChange[], policyVersion: string, ip: string | null): Promise<ConsentState[]> {
    assertRevocable(changes);
    await this.db.withTransaction(async (tx) => {
      for (const c of changes) {
        await this.consents.insert(tx, { userId, guestEmail: null, purpose: c.purpose, granted: c.granted, policyVersion, ip });
      }
    });
    return this.listForUser(userId);
  }

  /**
   * ¿Está otorgado el propósito? Con userId, sus filas. Con solo un email: si pertenece a un usuario
   * del tenant, las filas de ese usuario (su decisión como cliente registrado manda); si no, las
   * filas de invitado con ese guest_email. Sin filas: no.
   *
   * Límite del modelo: iam.consents no tiene tenant_id, así que el consentimiento de un invitado
   * vale para ese email en cualquier tenant.
   */
  async isGranted(tenantId: string, who: { userId?: string | null; email?: string | null }, purpose: ConsentPurpose): Promise<boolean> {
    let userId = who.userId ?? null;
    const email = who.email?.trim().toLowerCase() || null;
    if (!userId && email) userId = await this.users.findIdByEmail(this.db, tenantId, email);
    const records = userId
      ? await this.consents.listByUser(this.db, userId)
      : email
        ? await this.consents.listByGuestEmail(this.db, email)
        : [];
    return currentConsents(records).find((s) => s.purpose === purpose)?.granted ?? false;
  }
}
