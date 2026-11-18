import { Inject, Injectable } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import QRCode from 'qrcode';
import {
  APP_CONFIG,
  AppConfig,
  AuditLog,
  AuthUser,
  ConflictError,
  Database,
  ForbiddenError,
  NotFoundError,
  Queryable,
  UnauthenticatedError,
  ValidationError,
} from '../../../shared-kernel';
import { base32Encode, generateTotpSecret, otpauthUri, verifyTotp } from '../domain/totp';
import { UserType } from '../domain/user-account';
import { LoginAttempts } from './login-attempts';
import { MfaState, SecretBox, TotpReplayGuard, UserAccountRepository } from './ports';
import { RoleService } from './role.service';
import { ClientInfo, Session, SessionService } from './session.service';

/** Vida del mfaToken: lo que tiene el usuario para teclear el código tras la contraseña. */
export const MFA_TOKEN_TTL_SECONDS = 5 * 60;
const MFA_AUDIENCE = 'iam.mfa';

type Purpose = 'mfa-login' | 'mfa-setup';

interface ChallengeClaims {
  sub: string;
  tid: string;
  typ: UserType;
  pur: Purpose;
}

/** Respuesta del login cuando falta el segundo factor (en lugar del access token). */
export interface MfaChallenge {
  /** true: el usuario tiene 2FA, debe enviar el código a /auth/login/mfa. */
  mfaRequired?: true;
  /** true: su rol lo exige y aún no lo activó: /auth/mfa/setup y luego /auth/mfa/activate. */
  mfaSetupRequired?: true;
  mfaToken: string;
  expiresIn: number;
}

export interface MfaEnrollment {
  /** Secreto en base32 para teclearlo a mano si no se puede escanear el QR. */
  secret: string;
  otpauthUrl: string;
  /** PNG del QR como data URL (data:image/png;base64,...), listo para un <img>. */
  qrCodeDataUrl: string;
}

function invalidMfaCode(status: 401 | 422) {
  return () =>
    status === 401
      ? new UnauthenticatedError('INVALID_MFA_CODE', 'Código de verificación incorrecto')
      : new ValidationError('INVALID_MFA_CODE', 'Código de verificación incorrecto');
}

function invalidChallenge(): UnauthenticatedError {
  return new UnauthenticatedError('MFA_TOKEN_INVALID', 'La verificación expiró o no es válida: inicia sesión de nuevo');
}

/**
 * 2FA TOTP: alta con QR (secreto cifrado con libsodium en mfa_secret_enc), login en dos pasos
 * (contraseña → mfaToken → código) y desactivación. Obligatorio para el rol admin. Los códigos
 * erróneos cuentan para el bloqueo de 5 intentos y cada código sirve una sola vez.
 */
@Injectable()
export class MfaService {
  constructor(
    private readonly db: Database,
    private readonly accounts: UserAccountRepository,
    private readonly box: SecretBox,
    private readonly replay: TotpReplayGuard,
    private readonly attempts: LoginAttempts,
    private readonly sessions: SessionService,
    private readonly roles: RoleService,
    private readonly audit: AuditLog,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** ¿Este login necesita segundo factor? Sí si lo activó o si es admin (aunque aún no lo tenga). */
  async isRequired(q: Queryable, user: { id: string; tenantId: string; mfaEnabled: boolean }): Promise<boolean> {
    return user.mfaEnabled || this.roles.hasRole(q, user.tenantId, user.id, 'admin');
  }

  /**
   * mfaToken firmado con OTRA clave que el access token (MFA_CHALLENGE_SECRET) y con audiencia
   * propia: no sirve como Bearer en ninguna ruta.
   */
  challenge(user: { id: string; tenantId: string; type: UserType }, setupRequired: boolean): MfaChallenge {
    const claims: ChallengeClaims = { sub: user.id, tid: user.tenantId, typ: user.type, pur: setupRequired ? 'mfa-setup' : 'mfa-login' };
    const mfaToken = jwt.sign(claims, this.config.iam.mfaChallengeSecret, {
      algorithm: 'HS256',
      audience: MFA_AUDIENCE,
      expiresIn: MFA_TOKEN_TTL_SECONDS,
    });
    return setupRequired
      ? { mfaSetupRequired: true, mfaToken, expiresIn: MFA_TOKEN_TTL_SECONDS }
      : { mfaRequired: true, mfaToken, expiresIn: MFA_TOKEN_TTL_SECONDS };
  }

  /** Paso 2 del login: código TOTP → sesión (access token + refresh token). */
  async completeLogin(mfaToken: string, code: string, client: ClientInfo): Promise<Session> {
    const c = this.readChallenge(mfaToken, 'mfa-login');
    const state = await this.accounts.findMfaState(this.db, c.tid, c.sub);
    if (!state || state.status !== 'active' || !state.mfaEnabled || !state.secretEnc) throw invalidChallenge();
    const now = new Date();
    return this.attempts.settle(state.id, {
      ok: await this.checkCode(state, state.secretEnc, code, now),
      now,
      completesLogin: true,
      invalid: invalidMfaCode(401),
      onSuccess: (tx) => this.sessions.start(tx, state, client),
    });
  }

  /** Alta obligatoria (admin sin 2FA) durante el login: genera el secreto y devuelve el QR. */
  async setupWithChallenge(mfaToken: string): Promise<MfaEnrollment> {
    const c = this.readChallenge(mfaToken, 'mfa-setup');
    const state = await this.accounts.findMfaState(this.db, c.tid, c.sub);
    if (!state || state.status !== 'active') throw invalidChallenge();
    if (state.mfaEnabled) throw new ConflictError('MFA_ALREADY_ENABLED', 'El 2FA ya está activo: inicia sesión de nuevo');
    return this.enroll(state);
  }

  /** Confirma el alta con el primer código y abre la sesión (completa el login). */
  async activateWithChallenge(mfaToken: string, code: string, client: ClientInfo): Promise<Session> {
    const c = this.readChallenge(mfaToken, 'mfa-setup');
    const state = await this.pendingSetup(c.tid, c.sub);
    const now = new Date();
    return this.attempts.settle(state.id, {
      ok: await this.checkCode(state, state.secretEnc!, code, now),
      now,
      completesLogin: true,
      invalid: invalidMfaCode(401),
      onSuccess: async (tx) => {
        await this.enable(tx, state, { actorId: state.id, actorType: state.type, ip: client.ip });
        return this.sessions.start(tx, state, client);
      },
    });
  }

  /** Alta voluntaria desde "Mi cuenta" (cualquier usuario con sesión). */
  async setupForUser(user: AuthUser): Promise<MfaEnrollment> {
    const state = await this.stateOf(user);
    if (state.mfaEnabled) throw new ConflictError('MFA_ALREADY_ENABLED', 'El 2FA ya está activo');
    return this.enroll(state);
  }

  async activateForUser(user: AuthUser, code: string, ip: string | null): Promise<{ mfaEnabled: true }> {
    const state = await this.pendingSetup(user.tenantId, user.id);
    const now = new Date();
    return this.attempts.settle(state.id, {
      ok: await this.checkCode(state, state.secretEnc!, code, now),
      now,
      completesLogin: false,
      invalid: invalidMfaCode(422),
      onSuccess: async (tx) => {
        await this.enable(tx, state, { actorId: user.id, actorType: user.type, ip });
        return { mfaEnabled: true as const };
      },
    });
  }

  /** Desactiva con un código válido. Un admin no puede: para su rol el 2FA es obligatorio. */
  async disable(user: AuthUser, code: string, ip: string | null): Promise<{ mfaEnabled: false }> {
    const state = await this.stateOf(user);
    if (await this.roles.hasRole(this.db, user.tenantId, user.id, 'admin')) {
      throw new ForbiddenError('MFA_REQUIRED_FOR_ROLE', 'El 2FA es obligatorio para el rol admin');
    }
    if (!state.mfaEnabled || !state.secretEnc) throw new ConflictError('MFA_NOT_ENABLED', 'El 2FA no está activo');
    const now = new Date();
    return this.attempts.settle(state.id, {
      ok: await this.checkCode(state, state.secretEnc, code, now),
      now,
      completesLogin: false,
      invalid: invalidMfaCode(422),
      onSuccess: async (tx) => {
        await this.accounts.saveMfa(tx, state.id, null, false);
        await this.record(tx, state, 'iam.mfa.disabled', { actorId: user.id, actorType: user.type, ip });
        return { mfaEnabled: false as const };
      },
    });
  }

  /**
   * Un admin resetea el 2FA de otro usuario que perdió el teléfono (no hay códigos de
   * recuperación en el modelo). Cierra todas sus sesiones; si es admin, deberá darlo de alta
   * de nuevo en su próximo login.
   */
  async reset(actor: AuthUser, userId: string, ip: string | null): Promise<{ mfaEnabled: false; revokedSessions: number }> {
    if (actor.id === userId) throw new ForbiddenError('CANNOT_RESET_OWN_MFA', 'No puedes resetear tu propio 2FA');
    const state = await this.accounts.findMfaState(this.db, actor.tenantId, userId);
    if (!state) throw new NotFoundError('USER_NOT_FOUND', 'El usuario no existe en esta tienda');
    return this.db.withTransaction(async (tx) => {
      await this.accounts.saveMfa(tx, state.id, null, false);
      const revokedSessions = await this.sessions.revokeAll(tx, state.id);
      await this.record(tx, state, 'iam.mfa.reset', { actorId: actor.id, actorType: actor.type, ip }, { revokedSessions });
      return { mfaEnabled: false as const, revokedSessions };
    });
  }

  private async enroll(state: MfaState): Promise<MfaEnrollment> {
    const secret = generateTotpSecret();
    // Pendiente (mfa_enabled = false) hasta que el usuario confirme con un código: un QR mal
    // escaneado no lo deja fuera de su cuenta. Repetir el alta reemplaza el secreto pendiente.
    await this.accounts.saveMfa(this.db, state.id, await this.box.seal(secret), false);
    const otpauthUrl = otpauthUri(this.config.iam.mfaIssuer, state.email, secret);
    return { secret: base32Encode(secret), otpauthUrl, qrCodeDataUrl: await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 240 }) };
  }

  private async enable(tx: Queryable, state: MfaState, actor: { actorId: string; actorType: string; ip: string | null }): Promise<void> {
    await this.accounts.saveMfa(tx, state.id, state.secretEnc, true);
    await this.record(tx, state, 'iam.mfa.enabled', actor);
  }

  /** Código válido en la ventana ±30 s y no usado antes (anti-replay en Valkey). */
  private async checkCode(state: MfaState, secretEnc: Buffer, code: string, now: Date): Promise<boolean> {
    const step = verifyTotp(await this.box.open(secretEnc), code, now);
    return step !== null && (await this.replay.claim(state.id, step));
  }

  private async pendingSetup(tenantId: string, userId: string): Promise<MfaState> {
    const state = await this.accounts.findMfaState(this.db, tenantId, userId);
    if (!state || state.status !== 'active') throw invalidChallenge();
    if (state.mfaEnabled) throw new ConflictError('MFA_ALREADY_ENABLED', 'El 2FA ya está activo');
    if (!state.secretEnc) throw new ValidationError('MFA_SETUP_NOT_STARTED', 'Primero genera el código QR (setup)');
    return state;
  }

  private async stateOf(user: AuthUser): Promise<MfaState> {
    const state = await this.accounts.findMfaState(this.db, user.tenantId, user.id);
    if (!state) throw new UnauthenticatedError('USER_NOT_FOUND', 'El usuario del token ya no existe');
    return state;
  }

  private readChallenge(token: string, purpose: Purpose): ChallengeClaims {
    try {
      const claims = jwt.verify(token, this.config.iam.mfaChallengeSecret, {
        algorithms: ['HS256'],
        audience: MFA_AUDIENCE,
      }) as Partial<ChallengeClaims>;
      if (claims.pur !== purpose || !claims.sub || !claims.tid || !claims.typ) throw new Error('propósito');
      return claims as ChallengeClaims;
    } catch {
      throw invalidChallenge();
    }
  }

  private record(
    tx: Queryable,
    state: MfaState,
    action: string,
    actor: { actorId: string; actorType: string; ip: string | null },
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    return this.audit.record(tx, {
      tenantId: state.tenantId,
      actorId: actor.actorId,
      actorType: actor.actorType,
      actorIp: actor.ip,
      action,
      entityType: 'user',
      entityId: state.id,
      after: { mfaEnabled: action === 'iam.mfa.enabled', ...extra },
    });
  }
}
