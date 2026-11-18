import { INestApplication, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { MetadataScanner, ModulesContainer } from '@nestjs/core';
import { getMetadataStorage } from 'class-validator';
import { createTestApp } from '../support/test-app';

interface RouteArg {
  index: number;
  data?: unknown;
  pipes?: unknown[];
}

/**
 * Guardián de A03/A04: TODA entrada HTTP pasa por class-validator. Recorre las rutas registradas
 * en la app y falla si un @Body/@Query/@Param llega como objeto sin validar (interface, `any`,
 * Object) o como string suelto sin pipe. Una ruta nueva con un DTO olvidado rompe este test.
 */
describe('Validación: todas las entradas de la API pasan por un DTO o un pipe', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('ningún @Body, @Query ni @Param sin validar', () => {
    const scanner = new MetadataScanner();
    const controllers = [...app.get(ModulesContainer).values()].flatMap((m) => [...m.controllers.values()]);
    const storage = getMetadataStorage();
    const validated = (type: unknown) =>
      typeof type === 'function' && type !== Object && storage.getTargetValidationMetadatas(type as new () => unknown, '', true, false).length > 0;

    const problems: string[] = [];
    let routes = 0;
    for (const wrapper of controllers) {
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (!instance) continue;
      const proto = Object.getPrototypeOf(instance);
      const base = Reflect.getMetadata(PATH_METADATA, wrapper.metatype as object) ?? '';
      for (const method of scanner.getAllMethodNames(proto)) {
        const handler = proto[method];
        if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;
        routes++;
        const where = `${wrapper.name}.${method} (${RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler)]} /${base}/${Reflect.getMetadata(PATH_METADATA, handler)})`;
        const args: Record<string, RouteArg> = Reflect.getMetadata(ROUTE_ARGS_METADATA, proto.constructor, method) ?? {};
        const types: unknown[] = Reflect.getMetadata('design:paramtypes', proto, method) ?? [];
        for (const [key, arg] of Object.entries(args)) {
          const kind = Number(key.split(':')[0]);
          if (![RouteParamtypes.BODY, RouteParamtypes.QUERY, RouteParamtypes.PARAM].includes(kind)) continue;
          const label = `${RouteParamtypes[kind]}${arg.data ? `('${String(arg.data)}')` : ''}`;
          const type = types[arg.index];
          const hasPipe = (arg.pipes ?? []).length > 0;
          if (arg.data === undefined) {
            if (!validated(type)) problems.push(`${where}: ${label} no es una clase con class-validator`);
          } else if (!hasPipe && !validated(type)) {
            problems.push(`${where}: ${label} sin pipe ni DTO`);
          }
        }
      }
    }
    expect(routes).toBeGreaterThan(150);
    expect(problems).toEqual([]);
  });
});
