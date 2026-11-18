import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { APP_CONFIG, AppConfig } from '../../../shared-kernel';
import { TotpReplayGuard } from '../application/ports';
import { TOTP_PERIOD_SECONDS, TOTP_WINDOW } from '../domain/totp';

/**
 * Anti-replay en Valkey: SET iam:totp:<usuario>:<paso> NX con TTL algo mayor que la ventana de
 * validez del código. Un código interceptado (o tecleado dos veces) no sirve para un segundo login,
 * ni siquiera en otra réplica de la API. La clave expira sola: no hace falta columna nueva.
 */
@Injectable()
export class ValkeyTotpReplayGuard extends TotpReplayGuard implements OnModuleDestroy {
  private readonly redis: Redis;
  private readonly ttlSeconds = TOTP_PERIOD_SECONDS * (2 * TOTP_WINDOW + 1) + TOTP_PERIOD_SECONDS;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super();
    this.redis = new Redis(config.valkeyUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
  }

  async claim(userId: string, step: number): Promise<boolean> {
    const result = await this.redis.set(`iam:totp:${userId}:${step}`, '1', 'EX', this.ttlSeconds, 'NX');
    return result === 'OK';
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis.status !== 'wait' && this.redis.status !== 'end') await this.redis.quit();
  }
}
