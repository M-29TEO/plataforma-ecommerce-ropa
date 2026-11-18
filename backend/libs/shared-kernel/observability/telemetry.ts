import { hostname } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Span } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

/**
 * SDK de OpenTelemetry (trazas, métricas y logs por OTLP/HTTP hacia grafana/otel-lgtm).
 *
 * Se arranca ANTES de cargar Nest, express, pg o ioredis (apps/*\/instrumentation.ts es el primer
 * import de cada main.ts): la auto-instrumentación parchea los módulos al requerirlos.
 * Por eso este archivo solo importa paquetes de OpenTelemetry, nunca el index del shared kernel.
 *
 * Queda apagado si no hay OTEL_EXPORTER_OTLP_ENDPOINT o si OTEL_SDK_DISABLED=true (tests, scripts):
 * la API de @opentelemetry/api responde entonces con implementaciones no-op y nada se exporta.
 */

/** Rutas que no se trazan ni se miden: los healthchecks de Docker y Uptime Kuma (cada 30-60 s). */
const IGNORED_PATHS = new Set(['/v1/health']);

let sdk: NodeSDK | null = null;

export function telemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT) && env.OTEL_SDK_DISABLED !== 'true';
}

export function startTelemetry(serviceName: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (sdk || !telemetryEnabled(env)) return false;
  // Convenciones semánticas estables de HTTP: http.server.request.duration en segundos, con http.route.
  env.OTEL_SEMCONV_STABILITY_OPT_IN ??= 'http';
  const exportIntervalMillis = Number(env.OTEL_METRIC_EXPORT_INTERVAL ?? 15_000);

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME ?? serviceName,
      [ATTR_SERVICE_VERSION]: env.npm_package_version ?? '0.1.0',
      'service.namespace': 'moda',
      'service.instance.id': hostname(),
      'deployment.environment.name': env.NODE_ENV ?? 'development',
    }),
    // Los exporters leen OTEL_EXPORTER_OTLP_ENDPOINT y agregan /v1/traces, /v1/metrics y /v1/logs.
    traceExporter: new OTLPTraceExporter(),
    metricReader: new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(), exportIntervalMillis }),
    logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
    instrumentations: [
      getNodeAutoInstrumentations({
        // Ruido sin valor para este sistema.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingRequestHook: (req: IncomingMessage) => IGNORED_PATHS.has((req.url ?? '').split('?')[0]),
          // El X-Request-Id lo fija requestIdMiddleware; se copia al span para saltar de Tempo a Loki y a la auditoría.
          applyCustomAttributesOnSpan: (span: Span, _req: unknown, res: unknown) => {
            const id = (res as ServerResponse).getHeader?.('x-request-id');
            if (typeof id === 'string') span.setAttribute('request_id', id);
          },
        },
        // Sin parámetros de las consultas en los spans: pueden llevar datos personales (LOPDP).
        '@opentelemetry/instrumentation-pg': { enhancedDatabaseReporting: false },
      }),
    ],
  });
  sdk.start();
  return true;
}

/** Vacía y cierra los exporters (lo llama ObservabilityModule al apagarse la app). */
export async function shutdownTelemetry(): Promise<void> {
  const current = sdk;
  sdk = null;
  await current?.shutdown().catch(() => undefined);
}
