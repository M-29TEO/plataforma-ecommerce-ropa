import { AppConfig, loadConfig, Queryable, ValidationError } from '../../../../shared-kernel';
import { StoredTemplate, TemplateRepository } from '../../application/ports';
import { Channel } from '../../domain/channel';
import { DEFAULT_TEMPLATES } from './defaults';
import { HandlebarsTemplateEngine, htmlToText } from './handlebars-engine';

class FakeTemplates extends TemplateRepository {
  rows: StoredTemplate[] = [];
  async find(_q: Queryable, _t: string, code: string, channel: Channel, locale: string) {
    return this.rows.find((r) => r.code === code && r.channel === channel && r.locale === locale) ?? null;
  }
  async listForTenant() {
    return this.rows;
  }
  async upsert(): Promise<StoredTemplate> {
    throw new Error('no usado');
  }
}

const config: AppConfig = loadConfig({ DATABASE_URL: 'postgres://x', JWT_SECRET: 's', PAYSIM_SECRET: 'p', STOREFRONT_URL: 'https://tienda.test' });
const q = {} as Queryable;

function tenantRow(over: Partial<StoredTemplate>): StoredTemplate {
  return { id: 'x', code: 'order.placed', channel: 'email', locale: 'es-EC', subject: 'Propio', body: '<p>propio</p>', category: 'transactional', active: true, ...over };
}

describe('HandlebarsTemplateEngine', () => {
  let repo: FakeTemplates;
  let engine: HandlebarsTemplateEngine;

  beforeEach(() => {
    repo = new FakeTemplates();
    engine = new HandlebarsTemplateEngine(repo, config);
  });

  const order = {
    brand: 'Moda Demo',
    name: 'Ana',
    orderNumber: '1042',
    total: '26.00',
    paymentMethod: 'cod',
    items: [{ name: 'Blusa <lino>', variant: 'Blanco / M', quantity: 1, amount: '23.00' }],
    orderUrl: 'https://tienda.test/pedidos/1',
  };

  it('usa la plantilla del sistema en el idioma del usuario, con respaldo a es-EC', async () => {
    const en = await engine.resolve(q, 't', 'order.placed', 'email', 'en-GB');
    expect(en).toMatchObject({ locale: 'en-US', source: 'default' });
    const staffOnly = await engine.resolve(q, 't', 'invoice.rejected', 'ntfy', 'en-US');
    expect(staffOnly).toMatchObject({ locale: 'es-EC', source: 'default' });
    expect(await engine.resolve(q, 't', 'order.placed', 'sms', 'es-EC')).toBeNull();
  });

  it('la plantilla del tenant manda; inactiva apaga el mensaje en ese canal', async () => {
    repo.rows.push(tenantRow({}));
    expect(await engine.resolve(q, 't', 'order.placed', 'email', 'es-EC')).toMatchObject({ source: 'tenant', subject: 'Propio' });
    repo.rows[0].active = false;
    expect(await engine.resolve(q, 't', 'order.placed', 'email', 'es-EC')).toBeNull();
  });

  it('email: escapa las variables, aplica el layout y genera la versión de texto', async () => {
    const t = (await engine.resolve(q, 't', 'order.placed', 'email', 'es-EC'))!;
    const out = engine.render(t, order, { marketing: false });
    expect(out.subject).toBe('Recibimos tu pedido #1042');
    expect(out.html).toContain('Blusa &lt;lino&gt;');
    expect(out.html).toContain('<!doctype html>');
    expect(out.html).toContain('Este es un mensaje sobre tu compra');
    expect(out.html).toContain('Pagas al recibir');
    expect(out.html).toMatch(/\$26,00/);
    expect(out.text).toContain('Blusa <lino>');
    expect(out.text).toContain('Ver mi pedido (https://tienda.test/pedidos/1)');
    expect(out.text).not.toContain('<p>');
  });

  it('marketing: el pie lleva el enlace para gestionar el consentimiento', async () => {
    const t = (await engine.resolve(q, 't', 'cart.reminder.1h', 'email', 'es-EC'))!;
    const out = engine.render(t, { ...order, cartUrl: 'https://tienda.test/carrito' }, { marketing: true });
    expect(out.html).toContain('https://tienda.test/mi-cuenta/privacidad');
    expect(out.html).toContain('aceptaste recibir novedades');
  });

  it('textos planos (WhatsApp) sin escape HTML, montos en el formato del idioma', async () => {
    const es = (await engine.resolve(q, 't', 'order.placed', 'whatsapp', 'es-EC'))!;
    expect(engine.render(es, { ...order, brand: 'Moda & Co' }, { marketing: false }).text).toBe(
      'Moda & Co: recibimos tu pedido #1042 por $26,00. Síguelo aquí: https://tienda.test/pedidos/1',
    );
    const en = (await engine.resolve(q, 't', 'order.placed', 'whatsapp', 'en-US'))!;
    expect(engine.render(en, order, { marketing: false }).text).toContain('for $26.00');
  });

  it('fecha en America/Guayaquil', async () => {
    const t = (await engine.resolve(q, 't', 'order.delivered', 'email', 'es-EC'))!;
    const out = engine.render(t, { ...order, deliveredAt: '2026-10-01T17:00:00Z', returnWindowDays: 30 }, { marketing: false });
    expect(out.text).toContain('1 de octubre de 2026');
    expect(out.text).toContain('12:00');
  });

  it('validate rechaza Handlebars inválido', () => {
    expect(() => engine.validate('{{#if x}}sin cerrar')).toThrow(ValidationError);
    expect(() => engine.validate('Hola {{name}}')).not.toThrow();
  });

  it('todas las plantillas del sistema compilan y existen en es-EC para cada canal del catálogo', async () => {
    for (const [locale, codes] of Object.entries(DEFAULT_TEMPLATES)) {
      for (const [code, channels] of Object.entries(codes)) {
        for (const [channel, t] of Object.entries(channels ?? {})) {
          expect(() => engine.validate(t!.body)).not.toThrow();
          if (t!.subject) expect(() => engine.validate(t!.subject!)).not.toThrow();
          expect(`${locale}:${code}:${channel}`).toBeTruthy();
        }
      }
    }
    const { TEMPLATE_CATALOG } = await import('../../domain/catalog');
    const missing = Object.entries(TEMPLATE_CATALOG).flatMap(([code, e]) =>
      e.channels.filter((c) => !(DEFAULT_TEMPLATES['es-EC'] as Record<string, Record<string, unknown>>)[code]?.[c]).map((c) => `${code}:${c}`),
    );
    expect(missing).toEqual([]);
  });
});

describe('htmlToText', () => {
  it('enlaces, saltos y entidades', () => {
    expect(htmlToText('<p>Hola &amp; adiós</p><p><a href="https://x.test">Ir</a></p>')).toBe('Hola & adiós\nIr (https://x.test)');
  });
});
