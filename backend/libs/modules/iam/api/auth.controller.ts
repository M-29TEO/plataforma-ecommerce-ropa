import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import { APP_CONFIG, AppConfig, AuthUser, CurrentUser, DomainError, Public, RateLimit, readCookie, TenantId } from '../../../shared-kernel';
import { AuthService } from '../application/auth.service';
import { MfaService } from '../application/mfa.service';
import { ClientInfo, Session, SessionService } from '../application/session.service';
import { LoginDto, MfaLoginDto, MfaTokenDto, RegisterDto } from './dto/auth.dto';

export const REFRESH_COOKIE = 'refresh_token';
/**
 * Indicador NO secreto ("1") que acompaña a la cookie de refresh, legible por JavaScript y con
 * Path=/: el frontend solo intenta renovar al abrir si existe. Así un visitante anónimo no llama a
 * /auth/refresh en cada página (401 inútil que además gastaba el límite por IP).
 */
export const SESSION_HINT_COOKIE = 'session_hint';

export function clientInfo(req: Request): ClientInfo {
  const ua = req.headers['user-agent'];
  return { userAgent: typeof ua === 'string' ? ua : null, ip: req.ip ?? null };
}

/**
 * Registro, login y sesión. El access token va en el cuerpo (el frontend lo guarda en memoria);
 * el refresh token, en una cookie httpOnly (un XSS no la lee), SameSite=Strict (otro sitio no
 * la envía: sin CSRF) y con Path limitado a /auth (no viaja a ninguna otra ruta).
 * Anónimos: el tenant llega en el header X-Tenant-Id (lo fija Caddy por dominio).
 */
@Controller('auth')
@Public()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** 201 con el perfil creado; 409 EMAIL_TAKEN; 422 PASSWORD_TOO_SHORT / CONSENT_REQUIRED. */
  @Post('register')
  @HttpCode(201)
  @RateLimit('auth')
  register(@TenantId() tenantId: string, @Body() dto: RegisterDto, @Req() req: Request) {
    return this.auth.register({ tenantId, ...dto }, clientInfo(req));
  }

  /**
   * 200 con el JWT de acceso (15 min) + cookie refresh_token. Con 2FA (o rol admin), 200 con
   * { mfaRequired | mfaSetupRequired, mfaToken } y sin sesión todavía.
   * 401 INVALID_CREDENTIALS; 423 ACCOUNT_LOCKED.
   */
  @Post('login')
  @HttpCode(200)
  @RateLimit('auth')
  async login(@TenantId() tenantId: string, @Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(tenantId, dto.email, dto.password, clientInfo(req));
    return result.kind === 'mfa' ? result.challenge : this.withSession(res, result.session);
  }

  /** Segundo paso: código TOTP. 200 con la sesión; 401 INVALID_MFA_CODE / MFA_TOKEN_INVALID; 423. */
  @Post('login/mfa')
  @HttpCode(200)
  @RateLimit('auth')
  async loginMfa(@Body() dto: MfaLoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.withSession(res, await this.mfa.completeLogin(dto.mfaToken, dto.code, clientInfo(req)));
  }

  /** Alta obligatoria del 2FA (admin sin 2FA) durante el login: devuelve el QR y el secreto. */
  @Post('mfa/setup')
  @HttpCode(200)
  @RateLimit('auth')
  setupMfa(@Body() dto: MfaTokenDto) {
    return this.mfa.setupWithChallenge(dto.mfaToken);
  }

  /** Confirma el alta con el primer código y completa el login (sesión). */
  @Post('mfa/activate')
  @HttpCode(200)
  @RateLimit('auth')
  async activateMfa(@Body() dto: MfaLoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.withSession(res, await this.mfa.activateWithChallenge(dto.mfaToken, dto.code, clientInfo(req)));
  }

  /** Rota el refresh token de la cookie: 200 con un access token nuevo y la cookie reemplazada. */
  @Post('refresh')
  @HttpCode(200)
  @RateLimit('session')
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    try {
      return this.withSession(res, await this.sessions.refresh(readCookie(req.headers.cookie, REFRESH_COOKIE), clientInfo(req)));
    } catch (error) {
      // Sesión inválida, reutilizada o vencida: se borran las cookies para que el cliente no insista.
      if (error instanceof DomainError) clearSessionCookies(res, this.config);
      throw error;
    }
  }

  /** Cierra la sesión de este dispositivo (revoca la familia del refresh token). Siempre 204. */
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.sessions.logout(readCookie(req.headers.cookie, REFRESH_COOKIE));
    clearSessionCookies(res, this.config);
  }

  private withSession(res: Response, session: Session) {
    res.cookie(REFRESH_COOKIE, session.refreshToken, { ...refreshCookieOptions(this.config), expires: session.refreshExpiresAt });
    res.cookie(SESSION_HINT_COOKIE, '1', { ...hintCookieOptions(this.config), expires: session.refreshExpiresAt });
    return session.access;
  }
}

function refreshCookieOptions(config: AppConfig): CookieOptions {
  return { httpOnly: true, secure: config.secureCookies, sameSite: 'strict', path: config.iam.refreshCookiePath };
}

function hintCookieOptions(config: AppConfig): CookieOptions {
  return { httpOnly: false, secure: config.secureCookies, sameSite: 'strict', path: '/' };
}

function clearSessionCookies(res: Response, config: AppConfig): void {
  res.clearCookie(REFRESH_COOKIE, refreshCookieOptions(config));
  res.clearCookie(SESSION_HINT_COOKIE, hintCookieOptions(config));
}

/** Cerrar TODAS las sesiones exige estar autenticado (access token). */
@Controller('auth')
export class AuthenticatedAuthController {
  constructor(
    private readonly sessions: SessionService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Revoca todos los refresh tokens del usuario. Los access tokens emitidos vencen solos (≤ 15 min). */
  @Post('logout-all')
  @HttpCode(200)
  async logoutAll(@CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    const revokedSessions = await this.sessions.logoutAll(user.id);
    clearSessionCookies(res, this.config);
    return { revokedSessions };
  }
}

/** Usuario autenticado. Exige JWT por el guard global (sin @Public()). */
@Controller('me')
export class MeController {
  constructor(private readonly auth: AuthService) {}

  @Get()
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.tenantId, user.id);
  }
}
