// Primer import de main.ts: OpenTelemetry tiene que parchear http, express, pg e ioredis antes de que se carguen.
import { startTelemetry } from '../../libs/shared-kernel/observability/telemetry';

startTelemetry('moda-api');
