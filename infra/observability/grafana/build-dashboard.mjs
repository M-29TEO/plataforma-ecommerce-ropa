// Genera dashboards/moda-operacion.json (el dashboard que Grafana carga al iniciar).
// Editar aquí y regenerar:  node infra/observability/grafana/build-dashboard.mjs
// Las métricas vienen del backend por OTLP; Prometheus traduce los nombres (puntos → guiones bajos,
// unidad como sufijo, _total en los contadores): http.server.request.duration → http_server_request_duration_seconds.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROM = { type: 'prometheus', uid: 'prometheus' };
const LOKI = { type: 'loki', uid: 'loki' };
const API = 'service_name="moda-api"';
const HTTP = `http_server_request_duration_seconds`;

let id = 0;
const panels = [];
let y = 0;

function row(title) {
  panels.push({ type: 'row', title, id: ++id, collapsed: false, gridPos: { h: 1, w: 24, x: 0, y }, panels: [] });
  y += 1;
}

/** Agrega paneles en una fila de altura h; cada uno con su ancho w. */
function line(h, ...items) {
  let x = 0;
  for (const p of items) {
    panels.push({ ...p, id: ++id, gridPos: { h, w: p.w, x, y } });
    delete panels[panels.length - 1].w;
    x += p.w;
  }
  y += h;
}

const target = (expr, legendFormat = '', extra = {}) => ({ datasource: PROM, expr, legendFormat, ...extra });
const withRefs = (targets) => targets.map((t, i) => ({ ...t, refId: String.fromCharCode(65 + i) }));

function timeseries(title, w, targets, { unit = 'short', description, stack = false, thresholds } = {}) {
  return {
    type: 'timeseries',
    title,
    description,
    w,
    datasource: PROM,
    targets: withRefs(targets),
    fieldConfig: {
      defaults: {
        unit,
        custom: { drawStyle: 'line', lineWidth: 1, fillOpacity: stack ? 30 : 10, showPoints: 'never', stacking: { mode: stack ? 'normal' : 'none' }, ...(thresholds ? { thresholdsStyle: { mode: 'dashed' } } : {}) },
        ...(thresholds ? { thresholds: { mode: 'absolute', steps: thresholds } } : {}),
      },
      overrides: [],
    },
    options: { legend: { displayMode: 'table', placement: 'right', calcs: ['lastNotNull', 'max'] }, tooltip: { mode: 'multi', sort: 'desc' } },
  };
}

function stat(title, w, expr, { unit = 'short', description, thresholds = [{ color: 'green', value: null }], decimals } = {}) {
  return {
    type: 'stat',
    title,
    description,
    w,
    datasource: PROM,
    targets: withRefs([target(expr, '', { instant: true })]),
    fieldConfig: { defaults: { unit, decimals, color: { mode: 'thresholds' }, thresholds: { mode: 'absolute', steps: thresholds } }, overrides: [] },
    options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, colorMode: 'background', graphMode: 'area', textMode: 'value' },
  };
}

const RED = (warn, crit) => [
  { color: 'green', value: null },
  { color: 'orange', value: warn },
  { color: 'red', value: crit },
];

// ---------------- API ----------------
row('API (moda-api)');
line(
  4,
  stat('Requests por segundo', 4, `sum(rate(${HTTP}_count{${API}}[$__rate_interval]))`, { unit: 'reqps', decimals: 2 }),
  stat('Latencia p95 (global)', 4, `histogram_quantile(0.95, sum by (le) (rate(${HTTP}_bucket{${API}}[$__rate_interval])))`, {
    unit: 's',
    thresholds: RED(0.5, 1),
    description: 'Alerta "API: latencia p95 alta" sobre 1 s durante 5 min.',
  }),
  stat(
    'Errores 5xx',
    4,
    `(sum(rate(${HTTP}_count{${API}, http_response_status_code=~"5.."}[$__rate_interval])) or vector(0)) / sum(rate(${HTTP}_count{${API}}[$__rate_interval]))`,
    { unit: 'percentunit', decimals: 2, thresholds: RED(0.01, 0.05), description: 'Alerta "API: tasa de errores 5xx" sobre 5 % durante 5 min.' },
  ),
  stat(
    'Errores 4xx',
    4,
    `(sum(rate(${HTTP}_count{${API}, http_response_status_code=~"4.."}[$__rate_interval])) or vector(0)) / sum(rate(${HTTP}_count{${API}}[$__rate_interval]))`,
    { unit: 'percentunit', decimals: 2, thresholds: RED(0.2, 0.5), description: '401, 403, 404, 409, 422 y 429. Un salto suele ser un cliente roto o un sondeo (ver eventos de seguridad en los logs).' },
  ),
  stat('Pedidos última hora', 4, `sum(increase(outbox_events_published_total{event_type="OrderPlaced"}[1h])) or vector(0)`, { decimals: 0 }),
  stat('Facturas pendientes SRI', 4, `sum(sri_documents_pending) or vector(0)`, {
    decimals: 0,
    thresholds: RED(20, 100),
    description: 'Comprobantes en pending, signed, sent o received: el SRI todavía no los autoriza.',
  }),
);
line(
  9,
  timeseries(
    'Latencia p95 por endpoint',
    12,
    [target(`histogram_quantile(0.95, sum by (le, http_request_method, http_route) (rate(${HTTP}_bucket{${API}, http_route!=""}[$__rate_interval])))`, '{{http_request_method}} {{http_route}}')],
    { unit: 's', thresholds: [{ color: 'green', value: null }, { color: 'red', value: 1 }], description: 'Percentil 95 del histograma http.server.request.duration (OpenTelemetry), por ruta plantilla de Nest.' },
  ),
  timeseries(
    'Errores por endpoint (5xx y 4xx)',
    12,
    [
      target(`sum by (http_request_method, http_route, http_response_status_code) (rate(${HTTP}_count{${API}, http_response_status_code=~"5.."}[$__rate_interval]))`, '{{http_response_status_code}} {{http_request_method}} {{http_route}}'),
      target(`sum by (http_response_status_code) (rate(${HTTP}_count{${API}, http_response_status_code=~"4.."}[$__rate_interval]))`, '{{http_response_status_code}} (todas las rutas)'),
    ],
    { unit: 'reqps' },
  ),
);
line(
  8,
  timeseries('Requests por endpoint', 12, [target(`topk(10, sum by (http_request_method, http_route) (rate(${HTTP}_count{${API}}[$__rate_interval])))`, '{{http_request_method}} {{http_route}}')], { unit: 'reqps' }),
  {
    type: 'logs',
    title: 'Logs de error (api y worker)',
    description: 'Click en una línea → trace_id → la traza en Tempo. Filtrar por request_id: {service_name=~"moda-.*"} | request_id="<X-Request-Id>"',
    w: 12,
    datasource: LOKI,
    targets: [{ datasource: LOKI, refId: 'A', expr: '{service_name=~"moda-api|moda-worker"} | detected_level=~"error|fatal"' }],
    options: { showTime: true, wrapLogMessage: true, sortOrder: 'Descending', enableLogDetails: true, dedupStrategy: 'none' },
  },
);

// ---------------- Colas ----------------
row('Colas BullMQ (moda-worker)');
line(
  8,
  timeseries('Jobs en espera por cola', 8, [target(`max by (queue) (bullmq_queue_jobs{state=~"waiting|prioritized"})`, '{{queue}}')], {
    thresholds: [{ color: 'green', value: null }, { color: 'red', value: 100 }],
    description: 'waiting + prioritized. Alerta "Cola atascada" sobre 100 durante 10 min.',
  }),
  timeseries('Jobs activos por cola', 8, [target(`max by (queue) (bullmq_queue_jobs{state="active"})`, '{{queue}}')]),
  timeseries('Jobs fallidos por cola', 8, [target(`max by (queue) (bullmq_queue_jobs{state="failed"})`, '{{queue}}')], {
    description: 'Fallidos que BullMQ conserva. Alerta "Jobs fallidos" cuando suben en 15 min.',
  }),
);
line(
  6,
  {
    type: 'table',
    title: 'Profundidad actual por cola y estado',
    w: 24,
    datasource: PROM,
    targets: [{ datasource: PROM, refId: 'A', expr: 'max by (queue, state) (bullmq_queue_jobs)', instant: true, format: 'table' }],
    transformations: [
      { id: 'groupingToMatrix', options: { columnField: 'state', rowField: 'queue', valueField: 'Value' } },
    ],
    fieldConfig: { defaults: {}, overrides: [] },
    options: { showHeader: true },
  },
);

// ---------------- Negocio ----------------
row('Negocio');
line(
  8,
  timeseries('Pedidos por minuto', 12, [target(`sum(rate(outbox_events_published_total{event_type="OrderPlaced"}[$__rate_interval])) * 60 or vector(0)`, 'pedidos/min')], {
    description: 'Eventos OrderPlaced que publicó el relay del outbox (cada pedido confirmado en el checkout).',
  }),
  timeseries(
    'Eventos de dominio por minuto',
    12,
    [
      target(`sum by (event_type) (rate(outbox_events_published_total[$__rate_interval])) * 60`, '{{event_type}}'),
      target(`sum by (event_type) (rate(outbox_events_failed_total[$__rate_interval])) * 60`, 'FALLÓ {{event_type}}'),
    ],
    { stack: false, description: 'Lo que el relay del outbox publica. Las series FALLÓ son consumidores que lanzan error (se reintentan).' },
  ),
);
line(
  8,
  timeseries('Facturas pendientes del SRI por estado', 12, [target(`sum by (status, doc_type) (sri_documents_pending)`, '{{status}} ({{doc_type}})')], {
    stack: true,
    description: 'doc_type 01 = factura, 04 = nota de crédito.',
  }),
  stat('Pendiente más viejo', 6, `max(sri_documents_pending_oldest_age_seconds) or vector(0)`, {
    unit: 's',
    thresholds: RED(600, 1800),
    description: 'Alerta "SRI: comprobantes atascados" sobre 30 min.',
  }),
  stat('Rechazados por el SRI (24 h)', 6, `sum(sri_documents_rejected) or vector(0)`, {
    decimals: 0,
    thresholds: RED(1, 5),
    description: 'DEVUELTA o NO AUTORIZADO. Soporte recibe un ticket interno por cada uno.',
  }),
);

const dashboard = {
  uid: 'moda-operacion',
  title: 'Moda · Operación',
  description: 'API, colas BullMQ y negocio (pedidos y facturación SRI). Provisionado desde infra/observability/grafana.',
  tags: ['moda'],
  timezone: 'America/Guayaquil',
  editable: true,
  graphTooltip: 1,
  refresh: '30s',
  schemaVersion: 39,
  time: { from: 'now-1h', to: 'now' },
  templating: { list: [] },
  annotations: { list: [] },
  links: [],
  panels,
};

const out = join(dirname(fileURLToPath(import.meta.url)), 'dashboards', 'moda-operacion.json');
writeFileSync(out, `${JSON.stringify(dashboard, null, 2)}\n`);
console.log(`Escrito ${out} (${panels.length} paneles)`);
