import { Injectable } from '@nestjs/common';
import { Database, ValidationError } from '../../../shared-kernel';
import { ConsentPurpose } from '../domain/consent';
import { canLogIn, isLocked } from '../domain/user-account';
import { ConsentService } from './consent.service';
import { accountLocked, LoginAttempts } from './login-attempts';
import { CustomerSummary, PasswordHasher, UserAccountRepository, UserContact, UserDirectory } from './ports';

/**
 * Fachada para otros módulos: datos de contacto de un usuario y consentimientos LOPDP. Nadie
 * fuera de IAM lee iam.users ni iam.consents directamente.
 */
@Injectable()
export class IamApi {
  constructor(
    private readonly db: Database,
    private readonly users: UserDirectory,
    private readonly consents: ConsentService,
    private readonly accounts: UserAccountRepository,
    private readonly hasher: PasswordHasher,
    private readonly attempts: LoginAttempts,
  ) {}

  /** null si no existe, está borrado o fue anonimizado (derecho de supresión): no se le escribe. */
  async getContact(tenantId: string, userId: string): Promise<UserContact | null> {
    const contact = await this.users.findContact(this.db, tenantId, userId);
    return contact && contact.status !== 'anonymized' ? contact : null;
  }

  /**
   * Pedidos asistidos (backoffice): clientes del tenant por email, nombre, teléfono o cédula/RUC.
   * Términos de menos de 2 caracteres no buscan (devuelve []); máximo 20 resultados.
   */
  searchCustomers(tenantId: string, term: string, limit = 20): Promise<CustomerSummary[]> {
    const t = term.trim();
    if (t.length < 2) return Promise.resolve([]);
    return this.users.searchCustomers(this.db, tenantId, t.slice(0, 100), Math.min(Math.max(limit, 1), 20));
  }

  /** Cliente por id (null si no existe, no es cliente, está borrado o anonimizado). */
  findCustomer(tenantId: string, userId: string): Promise<CustomerSummary | null> {
    return this.users.findCustomer(this.db, tenantId, userId);
  }

  /** Staff activo con el permiso por alguno de sus roles (p. ej. el agente al que se asigna un ticket). */
  staffHasPermission(tenantId: string, userId: string, permission: string): Promise<boolean> {
    return this.users.staffHasPermission(this.db, tenantId, userId, permission);
  }

  hasConsent(tenantId: string, who: { userId?: string | null; email?: string | null }, purpose: ConsentPurpose): Promise<boolean> {
    return this.consents.isGranted(tenantId, who, purpose);
  }

  /**
   * Reautenticación antes de una acción irreversible (anonimizar la cuenta): un token robado no
   * basta, hay que saber la contraseña. Cada intento cuenta en el mismo contador que el login
   * (5 fallos seguidos bloquean 15 min), así no sirve para adivinarla sin límite.
   * 422 INVALID_PASSWORD si no coincide; 423 ACCOUNT_LOCKED si la cuenta está bloqueada.
   */
  async reauthenticate(tenantId: string, userId: string, password: string): Promise<void> {
    const profile = await this.accounts.findProfile(this.db, tenantId, userId);
    const account = profile ? await this.accounts.findForLogin(this.db, tenantId, profile.email) : null;
    const invalid = () => new ValidationError('INVALID_PASSWORD', 'La contraseña no es correcta');
    if (!account || account.id !== userId || !canLogIn(account)) throw invalid();
    const now = new Date();
    if (isLocked(account, now)) throw accountLocked(account.lockedUntil!);
    const ok = await this.hasher.verify(account.passwordHash!, password);
    await this.attempts.settle(userId, { ok, now, completesLogin: false, invalid, onSuccess: async () => undefined });
  }
}
