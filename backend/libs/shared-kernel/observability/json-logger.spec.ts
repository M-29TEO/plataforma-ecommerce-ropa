import { context, trace, TraceFlags } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { JsonLogger, parseLogLevel } from './json-logger';
import { runWithRequestContext } from './request-context';

function capture(level?: Parameters<typeof parseLogLevel>[0]) {
  const lines: Array<{ line: Record<string, unknown>; level: string }> = [];
  const logger = new JsonLogger('moda-test', { level: parseLogLevel(level), write: (l, lv) => lines.push({ line: JSON.parse(l), level: lv }) });
  return { logger, lines };
}

describe('JsonLogger', () => {
  const manager = new AsyncLocalStorageContextManager();
  beforeAll(() => context.setGlobalContextManager(manager.enable()));
  afterAll(() => {
    manager.disable();
    context.disable();
  });

  it('escribe una línea JSON con nivel, servicio, contexto y mensaje', () => {
    const { logger, lines } = capture();
    logger.log('API escuchando', 'Bootstrap');
    expect(lines).toHaveLength(1);
    expect(lines[0].line).toMatchObject({ level: 'info', service: 'moda-test', context: 'Bootstrap', msg: 'API escuchando' });
    expect(typeof lines[0].line.timestamp).toBe('string');
  });

  it('agrega request_id, tenant_id y user_id del request en curso', () => {
    const { logger, lines } = capture();
    const req = { headers: {}, user: { id: 'u-1', tenantId: '11111111-1111-4111-8111-111111111111' } };
    runWithRequestContext({ requestId: 'req-abc-123', req }, () => logger.warn('algo raro', 'Pagos'));
    expect(lines[0].line).toMatchObject({
      level: 'warn',
      request_id: 'req-abc-123',
      tenant_id: '11111111-1111-4111-8111-111111111111',
      user_id: 'u-1',
    });
  });

  it('el X-Tenant-Id del cliente solo se registra si es un uuid', () => {
    const { logger, lines } = capture();
    runWithRequestContext({ requestId: 'req-abc-123', req: { headers: { 'x-tenant-id': '"}\n{"inyectado' } } }, () => logger.log('x'));
    expect(lines[0].line.tenant_id).toBeUndefined();
  });

  it('agrega trace_id y span_id del span activo', () => {
    const { logger, lines } = capture();
    const spanContext = { traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331', traceFlags: TraceFlags.SAMPLED };
    context.with(trace.setSpan(context.active(), trace.wrapSpanContext(spanContext)), () => logger.log('con traza'));
    expect(lines[0].line).toMatchObject({ trace_id: spanContext.traceId, span_id: spanContext.spanId });
  });

  it('sin request ni span no inventa campos de correlación', () => {
    const { logger, lines } = capture();
    logger.log('suelto');
    expect(lines[0].line).not.toHaveProperty('request_id');
    expect(lines[0].line).not.toHaveProperty('trace_id');
  });

  it('error(message, stack, context) separa el stack como hace Nest', () => {
    const { logger, lines } = capture();
    const err = new Error('boom');
    logger.error('falló el job', err.stack, 'BillingJob');
    expect(lines[0]).toMatchObject({ level: 'error', line: { level: 'error', context: 'BillingJob', msg: 'falló el job' } });
    expect(String(lines[0].line.stack)).toContain('boom');
  });

  it('error(message, context) sin stack toma el string como contexto', () => {
    const { logger, lines } = capture();
    logger.error('sin stack', 'Relay');
    expect(lines[0].line).toMatchObject({ context: 'Relay', msg: 'sin stack' });
    expect(lines[0].line).not.toHaveProperty('stack');
  });

  it('un objeto se despliega como campos del JSON', () => {
    const { logger, lines } = capture();
    logger.log({ msg: 'GET /v1/orders 200', http_status: 200, duration_ms: 12.5 }, 'HTTP');
    expect(lines[0].line).toMatchObject({ msg: 'GET /v1/orders 200', http_status: 200, duration_ms: 12.5, context: 'HTTP' });
  });

  it('respeta el nivel mínimo (LOG_LEVEL)', () => {
    const { logger, lines } = capture('warn');
    logger.log('no sale');
    logger.debug('tampoco');
    logger.warn('sí sale');
    expect(lines.map((l) => l.line.msg)).toEqual(['sí sale']);
  });

  it('un nivel desconocido cae en log', () => {
    expect(parseLogLevel('ruidoso')).toBe('log');
    expect(parseLogLevel(undefined)).toBe('log');
  });
});
