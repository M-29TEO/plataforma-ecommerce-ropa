import { Global, Module } from '@nestjs/common';
import { Pool } from 'pg';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { AuditLog } from '../audit/audit-log';
import { FieldCipher } from '../security/field-cipher';
import { PersonalDataRegistry } from '../privacy/personal-data';
import { IdempotencyStore } from '../idempotency/idempotency';
import { Database, PG_POOL } from './database';

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new Pool({
          connectionString: config.databaseUrl,
          max: config.databasePoolMax,
          application_name: 'moda-backend',
        }),
    },
    Database,
    IdempotencyStore,
    AuditLog,
    FieldCipher,
    PersonalDataRegistry,
  ],
  exports: [Database, IdempotencyStore, AuditLog, FieldCipher, PersonalDataRegistry],
})
export class DatabaseModule {}
