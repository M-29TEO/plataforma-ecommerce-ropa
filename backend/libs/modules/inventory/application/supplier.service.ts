import { Injectable } from '@nestjs/common';
import { Database, ValidationError } from '../../../shared-kernel';
import { SupplierNotFoundError } from '../domain/errors';
import { normalizeRuc, Supplier, SupplierContact } from '../domain/supplier';
import { SupplierPatch, SupplierRepository } from './ports';

export interface CreateSupplierInput {
  name: string;
  ruc?: string | null;
  contact?: SupplierContact;
  leadTimeDays?: number | null;
}

@Injectable()
export class SupplierService {
  constructor(
    private readonly db: Database,
    private readonly suppliers: SupplierRepository,
  ) {}

  create(tenantId: string, input: CreateSupplierInput): Promise<Supplier> {
    return this.suppliers.insert(this.db, {
      tenantId,
      name: input.name.trim(),
      ruc: input.ruc ? normalizeRuc(input.ruc) : null,
      contact: input.contact ?? {},
      leadTimeDays: validLeadTime(input.leadTimeDays ?? null),
      active: true,
    });
  }

  async get(tenantId: string, id: string): Promise<Supplier> {
    const supplier = await this.suppliers.findById(this.db, tenantId, id);
    if (!supplier) throw new SupplierNotFoundError(id);
    return supplier;
  }

  list(tenantId: string, filter: { active?: boolean; search?: string }): Promise<Supplier[]> {
    return this.suppliers.list(this.db, tenantId, filter);
  }

  async update(tenantId: string, id: string, patch: SupplierPatch): Promise<Supplier> {
    const clean: SupplierPatch = { ...patch };
    if (patch.ruc) clean.ruc = normalizeRuc(patch.ruc);
    if (patch.leadTimeDays !== undefined) clean.leadTimeDays = validLeadTime(patch.leadTimeDays);
    if (patch.name !== undefined) clean.name = patch.name.trim();
    const updated = await this.suppliers.update(this.db, tenantId, id, clean);
    if (!updated) throw new SupplierNotFoundError(id);
    return updated;
  }
}

function validLeadTime(days: number | null): number | null {
  if (days === null) return null;
  if (!Number.isInteger(days) || days < 0 || days > 365) {
    throw new ValidationError('INVALID_LEAD_TIME', 'El tiempo de entrega debe estar entre 0 y 365 días');
  }
  return days;
}
