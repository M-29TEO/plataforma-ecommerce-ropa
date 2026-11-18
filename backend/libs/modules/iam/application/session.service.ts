import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig, AuditLog, Database, Queryable, signAccessToken, UnauthenticatedError } from '../../../shared-kernel';
import { decideRefresh, generateRefreshToken, hashRefreshToken } from '../domain/refresh-token';
import { UserType } from '../domain/user-account';
import { RefreshTokenRepository, UserAccountRepository } from './ports';
import { RoleService } from './role.service';

/** El JWT de acceso dura 15 minutos; la sesión la mantiene el refresh token. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

export interface AccessToken {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

/** Lo que el controlador necesita: el cuerpo de la respuesta y el refresh token para la cookie. */
export interface Session {
  access: AccessToken;
  refreshToken: string;
  refreshExpiresAt: Date;
}

/** Datos del cliente que quedan en iam.refresh_tokens (para listar o investigar sesiones). */
export interface ClientInfo {
  userAgent: string | null;
  ip: string | null;
}

export interface SessionSubject {
  id: string;
  tenantId: string;
  type: UserType;
}

type RefreshOutcome =
  | { kind: 'ok'; session: Session }
  | { kind: 'invalid' }
  | { kind: 'reused' }
  | { kind: 'expired' }
  | { kind: 'inactive' };

const ERRORS: Record<Exclude<RefreshOutcome['kind'], 'ok'>, [string, string]> = {
  invalid: ['REFRESH_TOKEN_INVALID', 'Sesión inválida: inicia sesión de nuevo'],
  reused: ['REFRESH_TOKEN_REUSED', 'Sesión revocada por seguridad: inicia sesión de nuevo'],
  expired: ['REFRESH_TOKEN_EXPIRED', 'La sesión expiró: inicia sesión de nuevo'],
  inactive: ['USER_INACTIVE', 'La cuenta ya no puede iniciar sesión'],
};

/**
 * Sesiones: access token JWT corto + refresh token opaco que rota en cada uso. Reutilizar un
 * refresh token ya rotado revoca toda su familia (indica que una copia fue robada).
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly db: Database,
    private readonly tokens: RefreshTokenRepository,
    private readonly users: UserAccountRepository,
    private readonly audit: AuditLog,
    private readonly roles: RoleService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Nueva sesión (familia nueva) tras un login completo. */
  start(q: Queryable, user: SessionSubject, client: ClientInfo): Promise<Session> {
    return this.issue(q, user, randomUUID(), client, new Date());
  }

  /**
   * Rota el refresh token. Los errores se lanzan DESPUÉS del COMMIT: la revocación de la
   * familia (y su auditoría) debe quedar escrita aunque la respuesta sea 401.
   */
  async refresh(token: string | null, client: ClientInfo): Promise<Session> {
    if (!token) throw new UnauthenticatedError(...ERRORS.invalid);
    const now = new Date();
    const outcome = await this.db.withTransaction(async (tx): Promise<RefreshOutcome> => {
      const stored = await this.tokens.findByHashForUpdate(tx, hashRefreshToken(token));
      if (!stored) return { kind: 'invalid' };

      const decision = decideRefresh(stored, now);
      const user = await this.users.findSessionUser(tx, stored.userId);
      if (decision === 'reused') {
        const revoked = await this.tokens.revokeFamily(tx, stored.familyId, now);
        if (user) {
          await this.audit.record(tx, {
            tenantId: user.tenantId,
            actorId: null,
            actorType: 'system',
            actorIp: client.ip,
            action: 'auth.refresh_reused',
            entityType: 'refresh_token_family',
            entityId: stored.familyId,
            after: { userId: user.id, revokedTokens: revoked, userAgent: client.userAgent },
          });
        }
        return { kind: 'reused' };
      }
      if (decision === 'expired') {
        await this.tokens.revoke(tx, stored.id, now);
        return { kind: 'expired' };
      }
      if (!user || user.deleted || user.status !== 'active') {
        await this.tokens.revokeFamily(tx, stored.familyId, now);
        return { kind: 'inactive' };
      }

      await this.tokens.revoke(tx, stored.id, now);
      return { kind: 'ok', session: await this.issue(tx, user, stored.familyId, client, now) };
    });

    if (outcome.kind !== 'ok') throw new UnauthenticatedError(...ERRORS[outcome.kind]);
    return outcome.session;
  }

  /** Cierra la sesión del dispositivo: revoca la familia del token. Sin token o desconocido: nada. */
  async logout(token: string | null): Promise<void> {
    if (!token) return;
    await this.db.withTransaction(async (tx) => {
      const stored = await this.tokens.findByHashForUpdate(tx, hashRefreshToken(token));
      if (stored) await this.tokens.revokeFamily(tx, stored.familyId, new Date());
    });
  }

  /** Cierra todas las sesiones del usuario (todos sus dispositivos). */
  logoutAll(userId: string): Promise<number> {
    return this.revokeAll(this.db, userId);
  }

  /** Igual que logoutAll pero dentro de la transacción del llamador (p. ej. reset del 2FA). */
  revokeAll(q: Queryable, userId: string): Promise<number> {
    return this.tokens.revokeAllForUser(q, userId, new Date());
  }

  private async issue(q: Queryable, user: SessionSubject, familyId: string, client: ClientInfo, now: Date): Promise<Session> {
    const refreshToken = generateRefreshToken();
    const refreshExpiresAt = new Date(now.getTime() + this.config.iam.refreshTtlDays * 24 * 60 * 60 * 1000);
    await this.tokens.insert(q, {
      userId: user.id,
      familyId,
      tokenHash: hashRefreshToken(refreshToken),
      userAgent: client.userAgent,
      ip: client.ip,
      expiresAt: refreshExpiresAt,
    });
    // Permisos vigentes de sus roles: un cambio de rol rige desde el siguiente login o refresh.
    const permissions = await this.roles.permissionsOf(q, user.tenantId, user.id);
    const accessToken = signAccessToken(
      { id: user.id, tenantId: user.tenantId, type: user.type, permissions },
      this.config.jwtSecret,
      ACCESS_TOKEN_TTL_SECONDS,
    );
    return { access: { accessToken, tokenType: 'Bearer', expiresIn: ACCESS_TOKEN_TTL_SECONDS }, refreshToken, refreshExpiresAt };
  }
}
