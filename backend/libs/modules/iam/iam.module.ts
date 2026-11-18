import { Module } from '@nestjs/common';
import { AuthController, AuthenticatedAuthController, MeController } from './api/auth.controller';
import { MyConsentsController } from './api/consents.controller';
import { MfaAdminController, MyMfaController } from './api/mfa.controller';
import { RolesAdminController } from './api/roles.controller';
import { UsersAdminController } from './api/users.controller';
import { AuthService } from './application/auth.service';
import { ConsentService } from './application/consent.service';
import { IamApi } from './application/iam.api';
import { LoginAttempts } from './application/login-attempts';
import { MfaService } from './application/mfa.service';
import {
  ConsentRepository,
  PasswordHasher,
  RefreshTokenRepository,
  RoleRepository,
  SecretBox,
  TotpReplayGuard,
  UserAccountRepository,
  UserAdminRepository,
  UserDirectory,
} from './application/ports';
import { RoleService } from './application/role.service';
import { SessionService } from './application/session.service';
import { UserAdminService } from './application/user-admin.service';
import { Argon2PasswordHasher } from './infrastructure/argon2-password-hasher';
import { IamPersonalDataContributor } from './infrastructure/personal-data.contributor';
import { PgConsentRepository } from './infrastructure/pg-consent.repository';
import { PgRefreshTokenRepository } from './infrastructure/pg-refresh-token.repository';
import { PgRoleRepository } from './infrastructure/pg-role.repository';
import { PgUserAccountRepository } from './infrastructure/pg-user-account.repository';
import { PgUserAdminRepository } from './infrastructure/pg-user-admin.repository';
import { PgUserDirectory } from './infrastructure/pg-user-directory';
import { SodiumSecretBox } from './infrastructure/sodium-secret-box';
import { ValkeyTotpReplayGuard } from './infrastructure/valkey-totp-replay-guard';

/**
 * Módulo IAM (schema iam): registro y login de clientes con argon2id y JWT de acceso de 15 min
 * (bloqueo tras 5 fallos) con refresh tokens rotativos en cookie httpOnly, perfil propio (/me), RBAC (7 roles del sistema por tenant, permisos en el JWT, asignación
 * auditada), gestión de usuarios del backoffice (alta de personal, bloqueo, reseteo de contraseña), 2FA TOTP (obligatorio para admin; secreto cifrado con libsodium), datos de contacto para otros módulos y
 * consentimientos LOPDP (iam.consents; términos y privacidad obligatorios al registrarse).
 */
@Module({
  controllers: [AuthController, AuthenticatedAuthController, MeController, MyConsentsController, RolesAdminController, UsersAdminController, MyMfaController, MfaAdminController],
  providers: [
    { provide: UserDirectory, useClass: PgUserDirectory },
    { provide: ConsentRepository, useClass: PgConsentRepository },
    { provide: UserAccountRepository, useClass: PgUserAccountRepository },
    { provide: PasswordHasher, useClass: Argon2PasswordHasher },
    { provide: RefreshTokenRepository, useClass: PgRefreshTokenRepository },
    { provide: RoleRepository, useClass: PgRoleRepository },
    { provide: UserAdminRepository, useClass: PgUserAdminRepository },
    { provide: SecretBox, useClass: SodiumSecretBox },
    { provide: TotpReplayGuard, useClass: ValkeyTotpReplayGuard },
    RoleService,
    SessionService,
    LoginAttempts,
    MfaService,
    UserAdminService,
    AuthService,
    ConsentService,
    IamApi,
    IamPersonalDataContributor,
  ],
  exports: [IamApi],
})
export class IamModule {}
