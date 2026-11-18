import { Global, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { shutdownTelemetry } from './telemetry';

/** Al apagarse la app (SIGTERM con enableShutdownHooks) vacía las trazas, métricas y logs pendientes. */
@Injectable()
export class TelemetryShutdown implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await shutdownTelemetry();
  }
}

/** Lo importan AppModule y WorkerModule. Sin SDK arrancado (tests) no hace nada. */
@Global()
@Module({ providers: [TelemetryShutdown] })
export class ObservabilityModule {}
