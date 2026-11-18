import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Database, Public } from '../../libs/shared-kernel';

/** Healthcheck para Docker/Caddy: 200 si la API responde y llega a PostgreSQL; 503 si no. */
@Controller('health')
@Public()
export class HealthController {
  constructor(private readonly db: Database) {}

  @Get()
  async check() {
    try {
      await this.db.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({ status: 'error', database: 'down' });
    }
    return { status: 'ok', database: 'up' };
  }
}
