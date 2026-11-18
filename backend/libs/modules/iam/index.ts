/**
 * API PÚBLICA del módulo IAM. Otros módulos solo pueden importar desde aquí.
 */
export { IamModule } from './iam.module';
export { IamApi } from './application/iam.api';
export type { CustomerSummary, UserContact } from './application/ports';
export { CONSENT_PURPOSES } from './domain/consent';
export type { ConsentPurpose, ConsentState } from './domain/consent';
