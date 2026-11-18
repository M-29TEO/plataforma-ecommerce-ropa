import type { LoggerService, LogLevel } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { requestLogFields } from './request-context';

const LEVELS: LogLevel[] = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'];
/** Nombre del nivel en el JSON (convención de Loki/Grafana: info en vez de log). */
const LEVEL_NAME: Record<LogLevel, string> = { verbose: 'trace', debug: 'debug', log: 'info', warn: 'warn', error: 'error', fatal: 'fatal' };
const SEVERITY: Record<LogLevel, SeverityNumber> = {
  verbose: SeverityNumber.TRACE,
  debug: SeverityNumber.DEBUG,
  log: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
  fatal: SeverityNumber.FATAL,
};
/** Igual que el ConsoleLogger de Nest: un string con líneas "at archivo:línea:col" es un stack. */
const STACK_RE = /^(.)+\n\s+at .+:\d+:\d+/;

export interface JsonLoggerOptions {
  /** Nivel mínimo (LOG_LEVEL): verbose, debug, log, warn, error o fatal. Por defecto, log. */
  level?: LogLevel;
  /** Destino de cada línea; por defecto stdout (error y fatal a stderr). Los tests capturan aquí. */
  write?: (line: string, level: LogLevel) => void;
}

/**
 * Logger de Nest que escribe una línea JSON por evento y la envía también a Loki por OTLP:
 *   {"timestamp","level","service","context","msg","request_id","tenant_id","user_id","trace_id","span_id",...}
 * request_id/tenant_id/user_id salen del request en curso (requestIdMiddleware); trace_id y span_id,
 * del span activo, así Grafana salta de un log a su traza en Tempo.
 *
 * Además de strings acepta objetos: logger.log({ msg: 'Pedido creado', orderId }) agrega orderId al JSON.
 */
export class JsonLogger implements LoggerService {
  private minLevel: number;
  private readonly write: (line: string, level: LogLevel) => void;

  constructor(
    private readonly service: string,
    opts: JsonLoggerOptions = {},
  ) {
    this.minLevel = LEVELS.indexOf(opts.level ?? 'log');
    this.write = opts.write ?? ((line, level) => (level === 'error' || level === 'fatal' ? process.stderr : process.stdout).write(`${line}\n`));
  }

  log(message: unknown, ...params: unknown[]): void {
    this.emit('log', message, params);
  }
  error(message: unknown, ...params: unknown[]): void {
    this.emit('error', message, params);
  }
  warn(message: unknown, ...params: unknown[]): void {
    this.emit('warn', message, params);
  }
  debug(message: unknown, ...params: unknown[]): void {
    this.emit('debug', message, params);
  }
  verbose(message: unknown, ...params: unknown[]): void {
    this.emit('verbose', message, params);
  }
  fatal(message: unknown, ...params: unknown[]): void {
    this.emit('fatal', message, params);
  }

  setLogLevels(levels: LogLevel[]): void {
    this.minLevel = Math.min(...levels.map((l) => LEVELS.indexOf(l)).filter((i) => i >= 0), LEVELS.length);
  }

  private emit(level: LogLevel, message: unknown, params: unknown[]): void {
    if (LEVELS.indexOf(level) < this.minLevel) return;
    const { context, stack, extra } = splitParams(level, params);
    const fields: Record<string, unknown> = {};
    let msg: string;
    if (message instanceof Error) {
      msg = message.message;
      fields.stack = message.stack;
    } else if (message !== null && typeof message === 'object') {
      const { msg: m, message: m2, ...rest } = message as Record<string, unknown>;
      msg = String(m ?? m2 ?? '');
      Object.assign(fields, rest);
    } else {
      msg = String(message);
    }
    if (stack) fields.stack = stack;
    if (extra.length > 0) fields.extra = extra;

    const span = trace.getActiveSpan()?.spanContext();
    const correlation: Record<string, string> = { ...requestLogFields() };
    if (span && trace.isSpanContextValid(span)) {
      correlation.trace_id = span.traceId;
      correlation.span_id = span.spanId;
    }

    const record = { timestamp: new Date().toISOString(), level: LEVEL_NAME[level], service: this.service, context, msg, ...correlation, ...fields };
    this.write(safeStringify(record), level);

    // A Loki por OTLP. El SDK agrega trace_id/span_id del contexto activo por su cuenta.
    logs.getLogger(this.service).emit({
      severityNumber: SEVERITY[level],
      severityText: LEVEL_NAME[level].toUpperCase(),
      body: msg,
      attributes: toAttributes({ context, ...requestLogFields(), ...fields }),
    });
  }
}

/** Mismas reglas que el ConsoleLogger de Nest: el último string es el contexto; en error, el anterior es el stack. */
function splitParams(level: LogLevel, params: unknown[]): { context?: string; stack?: string; extra: unknown[] } {
  const rest = [...params];
  let context: string | undefined;
  let stack: string | undefined;
  if (level === 'error' || level === 'fatal') {
    if (rest.length >= 2 && typeof rest[rest.length - 1] === 'string') {
      context = rest.pop() as string;
      const s = rest.pop();
      if (typeof s === 'string') stack = s;
    } else if (rest.length === 1 && typeof rest[0] === 'string') {
      if (STACK_RE.test(rest[0])) stack = rest.pop() as string;
      else context = rest.pop() as string;
    }
  } else if (rest.length > 0 && typeof rest[rest.length - 1] === 'string') {
    context = rest.pop() as string;
  }
  return { context, stack, extra: rest.filter((v) => v !== undefined) };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Error ? { message: v.message, stack: v.stack } : v));
  } catch {
    return JSON.stringify({ msg: '[log no serializable]' });
  }
}

/** Atributos OTLP: solo primitivos; lo demás va como JSON. */
function toAttributes(fields: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : safeStringify(v);
  }
  return out;
}

/** Nivel de LOG_LEVEL; uno desconocido cae en 'log'. */
export function parseLogLevel(value: string | undefined): LogLevel {
  return LEVELS.includes(value as LogLevel) ? (value as LogLevel) : 'log';
}
