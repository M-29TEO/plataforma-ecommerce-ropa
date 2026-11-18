/**
 * Genera un OpenAPI 3 de la API a partir de los metadatos de Nest (rutas, métodos, parámetros) y
 * de los DTOs de class-validator (esquemas JSON). Lo usa OWASP ZAP (zap-api-scan) para conocer y
 * atacar cada endpoint con cuerpos válidos. No levanta la app: NestFactory en modo preview no
 * instancia proveedores (no necesita base de datos).
 *
 *   node -r ts-node/register/transpile-only scripts/security/openapi.ts <salida.json> [server-url] [uuid-de-ejemplo]
 */
import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { MetadataScanner, ModulesContainer, NestFactory } from '@nestjs/core';
// Sin tipos propios en el subpath: es el MetadataStorage de class-transformer (@Type de los DTOs anidados).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { defaultMetadataStorage } = require('class-transformer/cjs/storage') as typeof import('class-transformer/types/storage');
import { validationMetadatasToSchemas } from 'class-validator-jsonschema';
import { AppModule } from '../../apps/api/app.module';
import { IS_PUBLIC_KEY, PERMISSIONS_KEY } from '../../libs/shared-kernel';

type Schema = Record<string, unknown>;

async function main(): Promise<void> {
  const [out = 'openapi.json', serverUrl = 'http://api:3000', sampleId = '00000000-0000-4000-8000-000000000000'] = process.argv.slice(2);
  process.env.JWT_SECRET ??= 'solo-para-generar-el-openapi';
  process.env.DATABASE_URL ??= 'postgres://x@localhost/x';
  process.env.PAYSIM_SECRET ??= 'x';
  const app = await NestFactory.create(AppModule, { preview: true, logger: false });
  const schemas = validationMetadatasToSchemas({ classTransformerMetadataStorage: defaultMetadataStorage, refPointerPrefix: '#/components/schemas/' });
  const scanner = new MetadataScanner();
  const paths: Record<string, Record<string, unknown>> = {};

  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const ctrl = wrapper.metatype as unknown as { prototype: Record<string, unknown> } & object;
      const base = String(Reflect.getMetadata(PATH_METADATA, ctrl) ?? '');
      const ctrlPublic = Reflect.getMetadata(IS_PUBLIC_KEY, ctrl) === true;
      for (const method of scanner.getAllMethodNames(ctrl.prototype)) {
        const handler = ctrl.prototype[method] as object;
        const verb = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (verb === undefined) continue;
        const sub = ([] as string[]).concat(Reflect.getMetadata(PATH_METADATA, handler) ?? '')[0];
        const route = `/v1/${[base, sub].filter(Boolean).join('/')}`.replace(/\/+/g, '/').replace(/\/$/, '');
        const oaPath = route.replace(/:(\w+)/g, '{$1}');
        const args: Record<string, { index: number; data?: string }> = Reflect.getMetadata(ROUTE_ARGS_METADATA, ctrl, method) ?? {};
        const types: Array<{ name?: string }> = Reflect.getMetadata('design:paramtypes', ctrl.prototype, method) ?? [];
        const parameters: Schema[] = [...route.matchAll(/:(\w+)/g)].map(([, name]) => ({
          name,
          in: 'path',
          required: true,
          schema: { type: 'string', example: /id$/i.test(name) ? sampleId : name === 'index' ? '0' : 'demo' },
        }));
        let requestBody: Schema | undefined;
        for (const [key, arg] of Object.entries(args)) {
          const kind = Number(key.split(':')[0]);
          const typeName = types[arg.index]?.name;
          const schema = typeName && schemas[typeName] ? { $ref: `#/components/schemas/${typeName}` } : { type: 'object' };
          if (kind === RouteParamtypes.BODY) {
            requestBody = { required: true, content: { 'application/json': { schema } } };
          } else if (kind === RouteParamtypes.FILE || kind === RouteParamtypes.FILES) {
            requestBody = { content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } } } };
          } else if (kind === RouteParamtypes.QUERY && !arg.data && typeName && schemas[typeName]) {
            const props = (schemas[typeName] as { properties?: Record<string, Schema> }).properties ?? {};
            for (const [name, s] of Object.entries(props)) parameters.push({ name, in: 'query', required: false, schema: s });
          }
        }
        const isPublic = ctrlPublic || Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true;
        const perms: string[] = Reflect.getMetadata(PERMISSIONS_KEY, handler) ?? Reflect.getMetadata(PERMISSIONS_KEY, ctrl) ?? [];
        paths[oaPath] ??= {};
        paths[oaPath][RequestMethod[verb].toLowerCase()] = {
          operationId: `${wrapper.name}_${method}`,
          summary: perms.length ? `Permisos: ${perms.join(', ')}` : isPublic ? 'Pública' : 'Autenticada',
          parameters,
          ...(requestBody ? { requestBody } : {}),
          security: isPublic ? [] : [{ bearer: [] }],
          responses: { default: { description: 'Respuesta' } },
        };
      }
    }
  }

  const doc = {
    openapi: '3.0.3',
    info: { title: 'Moda e-commerce API', version: '0.5.0' },
    servers: [{ url: serverUrl }],
    paths,
    components: { schemas, securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(doc, null, 2));
  console.log(`OpenAPI con ${Object.keys(paths).length} rutas en ${out}`);
  await app.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
