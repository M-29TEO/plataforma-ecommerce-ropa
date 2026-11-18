import { createHash } from 'node:crypto';
import { ExecutionContext, Global, Injectable, Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import {
  getOptionsToken,
  getStorageToken,
  Throttle,
  ThrottlerGuard,
  ThrottlerModule,
  ThrottlerModuleOptions,
  ThrottlerStorage,
} from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { APP_CONFIG, AppConfig } from '../config/app-config';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Dos ventanas por cliente (IP real, detrás de Caddy con `trust proxy`): 'default' = 1 minuto,
 * contra ráfagas (responde con el header Retry-After estándar), y 'hour' = 1 hora, contra goteo
 * sostenido. Todas las rutas tienen el perfil global; las sensibles declaran uno más estricto
 * con @RateLimit(perfil).
 */
export const RATE_LIMIT_PROFILES = {
  /** Toda la API. */
  global: { minute: 120, hour: 3000 },
  /** Login, registro, segundo factor y alta del 2FA: adivinar credenciales. */
  auth: { minute: 5, hour: 20 },
  /** Checkout, cotización de envío y pagos: reservan stock, llaman a couriers y a la pasarela. */
  checkout: { minute: 10, hour: 30 },
  /**
   * Búsquedas por un secreto corto o un dato adivinable (cupón, gift card, referido, ticket de
   * invitado por número de pedido + email, enlaces firmados): enumeración.
   */
  lookup: { minute: 10, hour: 60 },
  /**
   * Renovar la sesión (refresh). El token es de 256 bits (no se adivina): el límite solo frena
   * abusos. Va aparte de 'lookup' y es holgado porque cada recarga o pestaña nueva renueva, y una
   * oficina o una red móvil comparten la IP: con 10/min el personal quedaba deslogueado.
   */
  session: { minute: 60, hour: 1200 },
} as const;

export type RateLimitProfile = Exclude<keyof typeof RATE_LIMIT_PROFILES, 'global'>;

/**
 * Perfil estricto para la ruta (o el controlador). Las rutas de un mismo perfil comparten el
 * contador: 5 intentos de login por minuto son 5 entre /auth/login y /auth/login/mfa, no 5 de cada uno.
 */
export function RateLimit(profile: RateLimitProfile): MethodDecorator & ClassDecorator {
  const limits = RATE_LIMIT_PROFILES[profile];
  const generateKey = (_ctx: ExecutionContext, tracker: string, window: string) => bucketKey(profile, window, tracker);
  return Throttle({
    default: { limit: limits.minute, ttl: MINUTE, generateKey },
    hour: { limit: limits.hour, ttl: HOUR, generateKey },
  });
}

function bucketKey(scope: string, window: string, tracker: string): string {
  // Hash: la IP no queda en claro en Valkey y la clave tiene largo fijo.
  return `rl:${scope}:${window}:${createHash('sha256').update(tracker).digest('hex').slice(0, 32)}`;
}

/**
 * ThrottlerGuard global. El cliente es req.ip (X-Forwarded-For solo de los proxies de
 * TRUST_PROXY: un cliente no puede inventarse otra IP). Las rutas sin perfil propio comparten
 * un contador global por IP, no uno por ruta. Responde 429 con Retry-After.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  constructor(
    options: ThrottlerModuleOptions,
    storage: ThrottlerStorage,
    reflector: Reflector,
    private readonly config: AppConfig,
  ) {
    super(options, storage, reflector);
  }

  protected override async shouldSkip(): Promise<boolean> {
    return !this.config.security.rateLimit.enabled;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- firma de ThrottlerGuard
  protected override async getTracker(req: Record<string, any>): Promise<string> {
    return String(req.ip ?? req.socket?.remoteAddress ?? 'unknown');
  }

  protected override generateKey(_context: ExecutionContext, tracker: string, window: string): string {
    return bucketKey('global', window, tracker);
  }
}

@Global()
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): ThrottlerModuleOptions => ({
        throttlers: [
          { name: 'default', ttl: MINUTE, limit: RATE_LIMIT_PROFILES.global.minute },
          { name: 'hour', ttl: HOUR, limit: RATE_LIMIT_PROFILES.global.hour },
        ],
        errorMessage: 'Demasiadas solicitudes; intenta de nuevo en unos minutos',
        // Valkey: el contador es el mismo en todas las réplicas de la API y sobrevive a reinicios.
        storage:
          config.security.rateLimit.storage === 'valkey' && config.security.rateLimit.enabled
            ? new ThrottlerStorageRedisService(config.valkeyUrl, { keyPrefix: 'moda:', maxRetriesPerRequest: 2 })
            : undefined,
      }),
    }),
  ],
  providers: [
    {
      provide: APP_GUARD,
      inject: [getOptionsToken(), getStorageToken(), Reflector, APP_CONFIG],
      useFactory: (options: ThrottlerModuleOptions, storage: ThrottlerStorage, reflector: Reflector, config: AppConfig) =>
        new AppThrottlerGuard(options, storage, reflector, config),
    },
  ],
})
export class RateLimitModule {}

// Re-export para que los módulos no importen @nestjs/throttler directamente.
export { SkipThrottle } from '@nestjs/throttler';
