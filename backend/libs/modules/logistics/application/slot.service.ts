import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig, Database, ValidationError } from '../../../shared-kernel';
import { SlotNotFoundError, SlotTemplateNotFoundError, ZoneNotFoundError } from '../domain/errors';
import {
  addDays,
  assertValidTemplate,
  DeliverySlot,
  generateSlots,
  localDate,
  SlotTemplate,
  SlotTemplateProps,
} from '../domain/slot';
import { CoverageZone, servesRiders } from '../domain/zone';
import { SlotRepository, ZoneRepository } from './ports';

export type CreateTemplateInput = Omit<SlotTemplateProps, 'surcharge'> & { surcharge?: string };
export type UpdateTemplateInput = Partial<SlotTemplateProps>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LIST_DAYS = 62;

/**
 * SlotService: plantillas semanales por zona y franjas concretas con control de capacidad.
 * Las franjas se generan desde las plantillas (job horario del worker, al crear o cambiar una
 * plantilla y bajo demanda). Cambiar una plantilla NO modifica franjas ya generadas (pueden tener
 * reservas): el cupo de una franja concreta se ajusta con updateCapacity.
 */
@Injectable()
export class SlotService {
  private readonly logger = new Logger(SlotService.name);

  constructor(
    private readonly db: Database,
    private readonly zones: ZoneRepository,
    private readonly slots: SlotRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async listTemplates(tenantId: string, zoneId: string): Promise<SlotTemplate[]> {
    await this.zone(tenantId, zoneId);
    return this.slots.listTemplates(this.db, zoneId);
  }

  async createTemplate(tenantId: string, zoneId: string, input: CreateTemplateInput): Promise<SlotTemplate> {
    const zone = await this.zone(tenantId, zoneId);
    const props = assertValidTemplate({ ...input, surcharge: input.surcharge ?? '0' });
    const template = await this.slots.insertTemplate(this.db, zoneId, props);
    await this.generateFor(zone);
    return template;
  }

  async updateTemplate(tenantId: string, zoneId: string, id: string, patch: UpdateTemplateInput): Promise<SlotTemplate> {
    const zone = await this.zone(tenantId, zoneId);
    const current = await this.slots.findTemplate(this.db, zoneId, id);
    if (!current) throw new SlotTemplateNotFoundError(id);
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const { id: _id, zoneId: _z, ...props } = { ...current, ...defined };
    const updated = await this.slots.updateTemplate(this.db, zoneId, id, assertValidTemplate(props));
    if (!updated) throw new SlotTemplateNotFoundError(id);
    await this.generateFor(zone);
    return updated;
  }

  async deleteTemplate(tenantId: string, zoneId: string, id: string): Promise<void> {
    await this.zone(tenantId, zoneId);
    if (!(await this.slots.deleteTemplate(this.db, zoneId, id))) throw new SlotTemplateNotFoundError(id);
  }

  /** Franjas de la zona entre dos fechas locales (por defecto, los próximos días configurados). */
  async listSlots(tenantId: string, zoneId: string, from?: string, to?: string): Promise<DeliverySlot[]> {
    await this.zone(tenantId, zoneId);
    const fromDate = from ?? localDate(new Date());
    const toDate = to ?? addDays(fromDate, this.config.logistics.slotDaysAhead - 1);
    if (!DATE_RE.test(fromDate) || !DATE_RE.test(toDate) || toDate < fromDate || toDate > addDays(fromDate, MAX_LIST_DAYS)) {
      throw new ValidationError('INVALID_DATE_RANGE', `Rango de fechas inválido (AAAA-MM-DD, máximo ${MAX_LIST_DAYS} días)`);
    }
    return this.slots.listSlots(this.db, zoneId, fromDate, toDate);
  }

  async updateCapacity(tenantId: string, zoneId: string, slotId: string, capacity: number): Promise<DeliverySlot> {
    await this.zone(tenantId, zoneId);
    if (!Number.isInteger(capacity) || capacity < 0 || capacity > 10_000) {
      throw new ValidationError('INVALID_CAPACITY', 'La capacidad debe ser un entero entre 0 y 10000');
    }
    const slot = await this.slots.updateCapacity(this.db, zoneId, slotId, capacity);
    if (!slot) throw new SlotNotFoundError(slotId);
    return slot;
  }

  async generateForZone(tenantId: string, zoneId: string, now = new Date()): Promise<{ created: number }> {
    return { created: await this.generateFor(await this.zone(tenantId, zoneId), now) };
  }

  /** Job del worker: todas las zonas activas con motorizado de todos los tenants. */
  async generateAll(now = new Date()): Promise<{ zones: number; created: number }> {
    const zones = await this.zones.listRiderZones(this.db);
    let created = 0;
    for (const z of zones) {
      created += await this.insertFrom(z.zoneId, z.sameDayCutoff, now);
    }
    if (created > 0) this.logger.log(`Franjas generadas: ${created} en ${zones.length} zonas`);
    return { zones: zones.length, created };
  }

  private generateFor(zone: CoverageZone, now = new Date()): Promise<number> {
    if (!servesRiders(zone)) return Promise.resolve(0);
    return this.insertFrom(zone.id, zone.sameDayCutoff, now);
  }

  private async insertFrom(zoneId: string, sameDayCutoff: string | null, now: Date): Promise<number> {
    const templates = await this.slots.listTemplates(this.db, zoneId);
    const slots = generateSlots(zoneId, templates, {
      now,
      days: this.config.logistics.slotDaysAhead,
      leadMinutes: this.config.logistics.slotLeadMinutes,
      sameDayCutoff,
    });
    return this.slots.insertSlots(this.db, slots);
  }

  private async zone(tenantId: string, zoneId: string): Promise<CoverageZone> {
    const zone = await this.zones.findById(this.db, tenantId, zoneId);
    if (!zone) throw new ZoneNotFoundError(zoneId);
    return zone;
  }
}
