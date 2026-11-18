import { Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig, createObjectStorage } from '../../shared-kernel';
import { ReportExportsController, ReportsController } from './api/reports.controller';
import { ExportService } from './application/export.service';
import { ExportJobRepository, ReportRenderer, ReportsReader, ReportStorage, ViewRefresher } from './application/ports';
import { ReportQueryService } from './application/report-query.service';
import { ReportsJobs } from './infrastructure/jobs/reports.jobs';
import { PgExportJobRepository } from './infrastructure/pg-export-job.repository';
import { PgReportsReader } from './infrastructure/pg-reports.reader';
import { PgViewRefresher } from './infrastructure/pg-view-refresher';
import { ExcelPdfReportRenderer } from './infrastructure/render/report-renderer';

/**
 * Módulo Reportes (schema reports). Único módulo con permiso para leer varios schemas, y solo a
 * través de sus vistas materializadas (mv_sales_daily, mv_sales_items_daily,
 * mv_delivery_performance, mv_funnel_daily). No importa otros módulos ni emite eventos.
 * Adaptadores: ReportStorage → SeaweedFS o memoria (REPORT_EXPORT_STORAGE), ReportRenderer →
 * ExcelJS / pdfkit.
 */
@Module({
  controllers: [ReportsController, ReportExportsController],
  providers: [
    { provide: ReportsReader, useClass: PgReportsReader },
    { provide: ViewRefresher, useClass: PgViewRefresher },
    { provide: ExportJobRepository, useClass: PgExportJobRepository },
    { provide: ReportRenderer, useClass: ExcelPdfReportRenderer },
    {
      provide: ReportStorage,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig) => createObjectStorage(c.reports.exportStorage, c.reports.seaweedFilerUrl),
    },
    ReportQueryService,
    ExportService,
  ],
  exports: [ReportQueryService, ExportService, ViewRefresher],
})
export class ReportsModule {}

/** Jobs del proceso worker (refresco de vistas cada 15 min y exportes pendientes). Requiere QueueModule. */
@Module({ imports: [ReportsModule], providers: [ReportsJobs] })
export class ReportsWorkerModule {}
