import { ConsoleLogger, LoggerService } from '@nestjs/common';
import { JsonLogger, parseLogLevel } from './json-logger';

/**
 * Logger de los procesos (api, worker): JSON por defecto (LOG_FORMAT=json), o el de Nest en
 * colores con LOG_FORMAT=pretty para leerlo en la terminal. LOG_LEVEL fija el nivel mínimo.
 */
export function createAppLogger(service: string, env: NodeJS.ProcessEnv = process.env): LoggerService {
  const level = parseLogLevel(env.LOG_LEVEL);
  if (env.LOG_FORMAT === 'pretty') {
    const all = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'] as const;
    return new ConsoleLogger({ logLevels: all.slice(all.indexOf(level)) });
  }
  return new JsonLogger(service, { level });
}
