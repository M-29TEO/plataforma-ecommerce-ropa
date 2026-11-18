import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig, Database, UnauthenticatedError, ValidationError } from '../../../shared-kernel';
import { RegistrationConsents, registrationConsentChanges } from '../domain/consent';
import { assertPasswordPolicy } from '../domain/password-policy';
import { canLogIn, isLocked, normalizeEmail } from '../domain/user-account';
import { accountLocked, invalidCredentials, LoginAttempts } from './login-attempts';
import { MfaChallenge, MfaService } from './mfa.service';
import { ConsentRepository, PasswordHasher, UserAccountRepository, UserProfile } from './ports';
import { RoleService } from './role.service';
import { ClientInfo, Session, SessionService } from './session.service';

export interface RegisterInput {
  tenantId: string;
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  phone: string;
  consents: RegistrationConsents;
}

/** Login completo (sesión) o a mitad de camino (falta el segundo factor). */
export type LoginResult = { kind: 'session'; session: Session } | { kind: 'mfa'; challenge: MfaChallenge };

function requiredName(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new ValidationError('NAME_REQUIRED', `${field} es obligatorio`, { field });
  return trimmed;
}

/**
 * Registro de clientes (con sus consentimientos LOPDP), login con contraseña (bloqueo tras 5
 * fallos; segundo paso TOTP si tiene 2FA o es admin) y perfil propio.
 */
@Injectable()
export class AuthService {
  /** Hash ficticio para verificar cuando el email no existe: el tiempo de respuesta no lo delata. */
  private dummyHash?: Promise<string>;

  constructor(
    private readonly db: Database,
    private readonly accounts: UserAccountRepository,
    private readonly hasher: PasswordHasher,
    private readonly sessions: SessionService,
    private readonly roles: RoleService,
    private readonly attempts: LoginAttempts,
    private readonly mfa: MfaService,
    private readonly consents: ConsentRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Crea el cliente, su rol customer y sus consentimientos en UNA transacción: no queda una cuenta
   * sin la evidencia de que aceptó los términos y la privacidad (versión vigente e IP).
   */
  async register(input: RegisterInput, client: ClientInfo): Promise<UserProfile> {
    assertPasswordPolicy(input.password);
    const consentChanges = registrationConsentChanges(input.consents);
    const firstName = requiredName(input.firstName, 'firstName');
    const lastName = requiredName(input.lastName, 'lastName');

    const tenantStatus = await this.accounts.findTenantStatus(this.db, input.tenantId);
    if (tenantStatus !== 'active') {
      throw new ValidationError('TENANT_UNAVAILABLE', 'La tienda no existe o no está activa');
    }

    const passwordHash = await this.hasher.hash(input.password);
    await this.roles.ensureSystemRoles(this.db, input.tenantId);
    return this.db.withTransaction(async (tx) => {
      const user = await this.accounts.insertCustomer(tx, {
        tenantId: input.tenantId,
        email: normalizeEmail(input.email),
        passwordHash,
        firstName,
        lastName,
        phone: input.phone.trim(),
      });
      await this.roles.grantInitialRole(tx, input.tenantId, user.id, 'customer');
      for (const c of consentChanges) {
        await this.consents.insert(tx, {
          userId: user.id,
          guestEmail: null,
          purpose: c.purpose,
          granted: c.granted,
          policyVersion: this.config.iam.policyVersion,
          ip: client.ip,
        });
      }
      return user;
    });
  }

  /**
   * Verifica la contraseña fuera de la transacción (argon2 tarda) y registra el intento. Con 2FA
   * (o rol admin) la contraseña correcta NO abre sesión ni reinicia el contador de fallos:
   * devuelve un mfaToken para el segundo paso.
   */
  async login(tenantId: string, email: string, password: string, client: ClientInfo): Promise<LoginResult> {
    const account = await this.accounts.findForLogin(this.db, tenantId, normalizeEmail(email));
    if (!account || !canLogIn(account)) {
      await this.hasher.verify(await this.getDummyHash(), password);
      throw invalidCredentials();
    }

    const now = new Date();
    if (isLocked(account, now)) throw accountLocked(account.lockedUntil!);

    const matches = await this.hasher.verify(account.passwordHash!, password);
    const needsMfa = matches && (await this.mfa.isRequired(this.db, account));

    return this.attempts.settle<LoginResult>(account.id, {
      ok: matches,
      now,
      completesLogin: !needsMfa,
      invalid: invalidCredentials,
      onSuccess: async (tx) =>
        needsMfa
          ? { kind: 'mfa', challenge: this.mfa.challenge(account, !account.mfaEnabled) }
          : { kind: 'session', session: await this.sessions.start(tx, account, client) },
    });
  }

  /** Perfil del usuario del token. Si fue borrado después de emitirlo, el token ya no vale. */
  async me(tenantId: string, userId: string): Promise<UserProfile> {
    const profile = await this.accounts.findProfile(this.db, tenantId, userId);
    if (!profile || profile.status === 'anonymized') {
      throw new UnauthenticatedError('USER_NOT_FOUND', 'El usuario del token ya no existe');
    }
    return profile;
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= this.hasher.hash('contraseña-ficticia-solo-para-igualar-tiempos');
    return this.dummyHash;
  }
}
