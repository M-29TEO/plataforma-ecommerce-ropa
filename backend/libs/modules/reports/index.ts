/**
 * API PÚBLICA del módulo Reportes. Otros módulos solo pueden importar desde aquí.
 */
export { ReportsModule, ReportsWorkerModule } from './reports.module';
export { REPORT_KINDS, REPORT_PERMISSION } from './domain/report';
export type { ReportKind } from './domain/report';
export type { ExportFormat, ExportStatus } from './domain/export-job';
