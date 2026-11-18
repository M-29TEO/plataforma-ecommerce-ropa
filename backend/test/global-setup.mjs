// Levanta PostgreSQL + PostGIS y Valkey una sola vez para toda la suite y aplica las migraciones.
// Las variables de entorno definidas aquí las heredan los procesos de Jest que corren los tests.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer } from 'testcontainers';
import { runner } from 'node-pg-migrate';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Testcontainers busca Docker en la ruta por defecto (//./pipe/docker_engine en Windows).
 * Docker Desktop reciente usa otro pipe según el contexto activo; si DOCKER_HOST no está
 * definido, se toma el endpoint del contexto actual de `docker`.
 */
function useCurrentDockerContext() {
  if (process.env.DOCKER_HOST) return;
  try {
    const host = execFileSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], {
      encoding: 'utf8',
    }).trim();
    if (host) process.env.DOCKER_HOST = host;
  } catch {
    // Sin CLI de docker: Testcontainers intentará sus estrategias por defecto.
  }
}

export default async function globalSetup() {
  useCurrentDockerContext();
  const [postgres, valkey] = await Promise.all([
    new PostgreSqlContainer('postgis/postgis:16-3.4')
      .withDatabase('moda_test')
      .withCommand(['postgres', '-c', 'max_connections=200', '-c', 'fsync=off'])
      .start(),
    new GenericContainer('valkey/valkey:8-alpine').withExposedPorts(6379).start(),
  ]);

  const databaseUrl = postgres.getConnectionUri();
  await runner({
    databaseUrl,
    dir: path.join(root, 'migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    count: Infinity,
    checkOrder: true,
    log: () => {},
  });

  process.env.DATABASE_URL = databaseUrl;
  process.env.DATABASE_POOL_MAX = '20';
  process.env.VALKEY_URL = `redis://${valkey.getHost()}:${valkey.getMappedPort(6379)}`;
  process.env.JWT_SECRET = 'secreto-solo-para-tests';
  process.env.PAYSIM_SECRET = 'secreto-pasarela-solo-para-tests';
  process.env.VOUCHER_STORAGE = 'memory';
  process.env.RETURN_PHOTO_STORAGE = 'memory';
  // Reversos de reembolsos: pasarela apagada (puerto 9) salvo que un archivo levante la suya.
  process.env.PAYSIM_API_URL = 'http://127.0.0.1:9';
  process.env.PAYMENT_REFUND_TIMEOUT_MS = '1000';
  // Sin OSRM (distancia en línea recta) y con el courier simulado apagado (puerto 9 = discard,
  // la conexión se rechaza al instante): los tests cotizan con courier_rate_cards salvo que un
  // archivo levante su propio courier falso y cambie COURIERSIM_URL.
  process.env.OSRM_URL = '';
  process.env.COURIERSIM_URL = 'http://127.0.0.1:9';
  process.env.COURIERSIM_API_KEY = 'api-key-courier-solo-para-tests';
  // Facturación: XML/RIDE y emails en memoria, firma con el certificado de test/fixtures/sri y el
  // SRI apagado (puerto 9) salvo que un archivo levante su SRI falso y cambie SRI_URL.
  process.env.DOCUMENT_STORAGE = 'memory';
  process.env.MAIL_TRANSPORT = 'memory';
  process.env.SRI_CERT_PATH = path.join(root, 'test/fixtures/sri/firma.crt.pem');
  process.env.SRI_KEY_PATH = path.join(root, 'test/fixtures/sri/firma.key.pem');
  process.env.SRI_URL = 'http://127.0.0.1:9';
  process.env.SRI_TIMEOUT_MS = '1000';
  // Notificaciones: email, Web Push y ntfy en memoria (WhatsApp y SMS son siempre simulados).
  process.env.NOTIFICATION_TRANSPORT = 'memory';
  // Reportes: archivos exportados en memoria.
  process.env.REPORT_EXPORT_STORAGE = 'memory';
  // Rate limiting apagado: los archivos hacen decenas de checkouts desde 127.0.0.1. Lo prueba
  // test/platform/security.int-spec.ts, que lo enciende en su propia app.
  process.env.RATE_LIMIT_ENABLED = 'false';

  globalThis.__TEST_CONTAINERS__ = [postgres, valkey];
}
