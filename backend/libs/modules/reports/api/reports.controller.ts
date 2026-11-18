import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Audited, Auth, AuthUser, CurrentUser, missingPermission, sendStoredFile } from '../../../shared-kernel';
import { ExportService, ExportView } from '../application/export.service';
import { ReportQueryService } from '../application/report-query.service';
import { REPORT_PERMISSION, ReportKind } from '../domain/report';
import { CreateExportDto, ListExportsQuery, RangeQuery, ReportQueryDto } from './dto/reports.dto';

/**
 * Dashboard del gerente. Lee las vistas materializadas (refrescadas cada 15 min por el worker),
 * nunca las tablas transaccionales; cada respuesta trae dataAsOf. Montos en USD como string.
 */
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportQueryService) {}

  /** Tablero: ventas, ticket promedio, margen, conversión, abandonos y entregas vs. el período anterior. */
  @Get('kpis')
  @Auth('reports.sales.read', 'reports.funnel.read', 'reports.delivery.read')
  kpis(@CurrentUser() user: AuthUser, @Query() q: RangeQuery) {
    return this.reports.kpis(user.tenantId, q);
  }

  /** ?groupBy=day|week|month|city|neighborhood|payment_method|fulfillment_type|channel|courier|rider */
  @Get('sales')
  @Auth('reports.sales.read')
  sales(@CurrentUser() user: AuthUser, @Query() q: ReportQueryDto) {
    return this.reports.report('sales', user.tenantId, q);
  }

  /** ?groupBy=category|size|color|product (ordenado por ventas netas, tope limit). */
  @Get('sales/items')
  @Auth('reports.sales.read')
  salesItems(@CurrentUser() user: AuthUser, @Query() q: ReportQueryDto) {
    return this.reports.report('sales_items', user.tenantId, q);
  }

  /** ?groupBy=day|week|month|carrier_type|courier|rider|zone */
  @Get('delivery')
  @Auth('reports.delivery.read')
  delivery(@CurrentUser() user: AuthUser, @Query() q: ReportQueryDto) {
    return this.reports.report('delivery', user.tenantId, q);
  }

  /** ?groupBy=day|week|month: carritos, abandonos y conversión (ventas / carritos con productos). */
  @Get('funnel')
  @Auth('reports.funnel.read')
  funnel(@CurrentUser() user: AuthUser, @Query() q: ReportQueryDto) {
    return this.reports.report('funnel', user.tenantId, q);
  }
}

/** Exportes Excel/PDF: se piden (202), el worker los genera y se descargan desde SeaweedFS. */
@Controller('reports/exports')
export class ReportExportsController {
  constructor(private readonly exports: ExportService) {}

  /** Exige reports.export y además el permiso de lectura del reporte pedido. */
  @Post()
  @HttpCode(202)
  @Auth('reports.export')
  @Audited('reports.export.create', { entity: 'report_export' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateExportDto) {
    assertCanRead(user, dto.report);
    return this.exports.request({ tenantId: user.tenantId, userId: user.id, ...dto });
  }

  /** Solo los propios (requested_by = usuario actual). */
  @Get()
  @Auth('reports.export')
  list(@CurrentUser() user: AuthUser, @Query() q: ListExportsQuery) {
    return this.exports.listMine(user.tenantId, user.id, q.limit);
  }

  @Get(':id')
  @Auth('reports.export')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.readable(user, id);
  }

  /** 409 EXPORT_NOT_READY mientras se genera; 409 EXPORT_EXPIRED después de REPORTS_EXPORT_TTL_DAYS. */
  @Get(':id/download')
  @Auth('reports.export')
  @Audited('reports.export.download', { entity: 'report_export' })
  async download(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    await this.readable(user, id);
    const file = await this.exports.download(user.tenantId, id, user.id);
    sendStoredFile(res, file, { filename: file.filename, download: true });
  }

  /**
   * El exporte es propio (si no, 404) y el usuario debe poder leer ese reporte HOY: un exporte de
   * ventas pedido antes de perder reports.sales.read ya no se puede ver ni descargar.
   */
  private async readable(user: AuthUser, id: string): Promise<ExportView> {
    const job = await this.exports.get(user.tenantId, id, user.id);
    assertCanRead(user, job.report);
    return job;
  }
}

/** reports.export no basta: también el permiso de lectura del reporte (REPORT_PERMISSION). */
function assertCanRead(user: AuthUser, report: ReportKind): void {
  const needed = REPORT_PERMISSION[report];
  if (!user.permissions.includes(needed)) throw missingPermission([needed], user);
}
