import { DynamicModule, Global, Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig, loadConfig } from './app-config';

@Global()
@Module({})
export class ConfigModule {
  /** En tests se puede pasar una configuración explícita; por defecto se lee de process.env. */
  static forRoot(config?: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useFactory: () => config ?? loadConfig() }],
      exports: [APP_CONFIG],
    };
  }
}
