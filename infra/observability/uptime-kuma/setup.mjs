// Configura Uptime Kuma 1.x sin clics: crea el admin (si Kuma está recién instalado), la notificación
// de ntfy y los monitores de /v1/health. Idempotente: lo que ya existe (mismo nombre) no se duplica.
// Uptime Kuma 1.x no tiene API REST de escritura; esto usa el mismo socket.io que su interfaz web.
//
// Corre como servicio de un solo uso del perfil obs (docker-compose.yml, kuma-setup):
//   docker compose --profile obs up -d uptime-kuma && docker compose --profile obs run --rm kuma-setup
import { io } from 'socket.io-client';

const env = (name, fallback) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Falta la variable ${name}`);
  return v;
};

const KUMA_URL = env('KUMA_URL', 'http://uptime-kuma:3001');
const USER = env('KUMA_ADMIN_USER', 'admin');
const PASSWORD = env('KUMA_ADMIN_PASSWORD');
const NTFY_URL = env('NTFY_URL', 'http://ntfy:80');
const NTFY_TOPIC = env('NTFY_OPS_TOPIC');
const INTERVAL = Number(env('KUMA_INTERVAL_SECONDS', '60'));

const NOTIFICATION_NAME = 'ntfy · operación';

/** Monitores HTTP: la API directa (red interna) y la ruta pública completa (WAF → Caddy → API). */
const MONITORS = [
  { name: 'API /v1/health (interna)', url: env('KUMA_API_HEALTH_URL', 'http://api:3000/v1/health') },
  { name: 'Tienda /api/v1/health (WAF + Caddy)', url: env('KUMA_PUBLIC_HEALTH_URL', 'http://waf:8080/api/v1/health') },
];

/** Campos que la interfaz de Kuma 1.23 manda al crear un monitor HTTP. */
function httpMonitor({ name, url }, notificationId) {
  return {
    type: 'http',
    name,
    url,
    method: 'GET',
    interval: INTERVAL,
    retryInterval: INTERVAL,
    resendInterval: 0,
    maxretries: 1, // un fallo aislado no despierta a nadie: avisa al segundo seguido
    timeout: 10,
    active: true,
    accepted_statuscodes: ['200-299'],
    maxredirects: 10,
    ignoreTls: false,
    upsideDown: false,
    expiryNotification: false,
    notificationIDList: notificationId ? { [notificationId]: true } : {},
    description: 'Creado por infra/observability/uptime-kuma/setup.mjs',
    headers: '',
    body: '',
    httpBodyEncoding: 'json',
    authMethod: null,
    dns_resolve_type: 'A',
    dns_resolve_server: '1.1.1.1',
    docker_container: '',
    docker_host: null,
    proxyId: null,
    mqttUsername: '',
    mqttPassword: '',
    mqttTopic: '',
    mqttSuccessMessage: '',
    kafkaProducerBrokers: [],
    kafkaProducerSaslOptions: { mechanism: 'None' },
    kafkaProducerSsl: false,
    kafkaProducerAllowAutoTopicCreation: false,
  };
}

function connect() {
  const socket = io(KUMA_URL, { transports: ['websocket'], reconnection: false, timeout: 10_000 });
  // Kuma empuja estas listas al loguearse; se guardan para comparar por nombre.
  const state = { monitors: null, notifications: null };
  socket.on('monitorList', (list) => (state.monitors = Object.values(list)));
  socket.on('notificationList', (list) => (state.notifications = list));
  const call = (event, ...args) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Kuma no respondió a ${event}`)), 15_000);
      socket.emit(event, ...args, (res) => {
        clearTimeout(timer);
        resolve(res);
      });
    });
  const ready = new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return { socket, state, call, ready };
}

async function until(cond, what, ms = 15_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`Kuma no envió ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Kuma tarda unos segundos en aceptar conexiones después de arrancar. */
async function connectWithRetry(attempts = 30) {
  for (let i = 1; ; i++) {
    const kuma = connect();
    try {
      await kuma.ready;
      return kuma;
    } catch (e) {
      kuma.socket.close();
      if (i >= attempts) throw new Error(`No se pudo conectar a ${KUMA_URL}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function main() {
  const kuma = await connectWithRetry();
  const { call, state } = kuma;

  if (await call('needSetup')) {
    const res = await call('setup', USER, PASSWORD);
    if (!res?.ok) throw new Error(`No se pudo crear el admin: ${res?.msg}`);
    console.log(`Admin "${USER}" creado`);
  }
  const login = await call('login', { username: USER, password: PASSWORD, token: '' });
  if (!login?.ok) throw new Error(`Login en Kuma falló: ${login?.msg ?? 'sin respuesta'} (¿KUMA_ADMIN_PASSWORD distinta a la del admin existente?)`);
  await until(() => state.monitors && state.notifications, 'las listas de monitores y notificaciones');

  let notification = state.notifications.find((n) => n.name === NOTIFICATION_NAME);
  if (!notification) {
    const config = { name: NOTIFICATION_NAME, type: 'ntfy', ntfyserverurl: NTFY_URL, ntfytopic: NTFY_TOPIC, ntfyPriority: 5, isDefault: true, applyExisting: true };
    const res = await call('addNotification', config, null);
    if (!res?.ok) throw new Error(`No se pudo crear la notificación: ${res?.msg}`);
    notification = { id: res.id };
    console.log(`Notificación "${NOTIFICATION_NAME}" creada (${NTFY_URL}/${NTFY_TOPIC})`);
  } else {
    console.log(`Notificación "${NOTIFICATION_NAME}" ya existía`);
  }

  for (const m of MONITORS) {
    if (state.monitors.some((existing) => existing.name === m.name)) {
      console.log(`Monitor "${m.name}" ya existía`);
      continue;
    }
    const res = await call('add', httpMonitor(m, notification.id));
    if (!res?.ok) throw new Error(`No se pudo crear el monitor "${m.name}": ${res?.msg}`);
    console.log(`Monitor "${m.name}" creado → ${m.url} cada ${INTERVAL} s`);
  }
  kuma.socket.close();
}

main().catch((e) => {
  console.error(`kuma-setup: ${e.message}`);
  process.exit(1);
});
