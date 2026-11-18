import { Module } from '@nestjs/common';
import { IamModule } from '../iam';
import { PrivacyController } from './api/privacy.controller';
import { PrivacyService } from './application/privacy.service';

/**
 * Privacidad (LOPDP): orquestador de exportar mis datos y anonimizar la cuenta. Nadie lo
 * importa; los módulos se inscriben en el PersonalDataRegistry del shared kernel.
 */
@Module({
  imports: [IamModule],
  controllers: [PrivacyController],
  providers: [PrivacyService],
})
export class PrivacyModule {}
