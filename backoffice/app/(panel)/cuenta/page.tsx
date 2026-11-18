'use client';

import { useState } from 'react';
import { useAuth } from '@/components/providers/AuthProvider';
import { useToast } from '@/components/providers/ToastProvider';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { api, errorMessage } from '@/lib/api/client';
import { formatDateTime, fullName } from '@/lib/format';
import type { MfaEnrollment } from '@/lib/types';

/**
 * Mi cuenta: datos propios, 2FA (alta voluntaria; un admin no puede desactivarlo) y cerrar todas
 * las sesiones (p. ej. si perdió un equipo).
 */
export default function AccountPage() {
  const { user, permissions, reloadProfile, logout } = useAuth();
  const toast = useToast();
  const [enrollment, setEnrollment] = useState<MfaEnrollment | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!user) return null;

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const startSetup = () => run(async () => setEnrollment(await api<MfaEnrollment>('/me/mfa/setup', { method: 'POST' })));

  const activate = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api('/me/mfa/activate', { method: 'POST', body: { code: code.replace(/\s/g, '') } });
      setEnrollment(null);
      setCode('');
      await reloadProfile();
      toast.ok('Verificación en dos pasos activada');
    });
  };

  const disable = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api('/me/mfa', { method: 'DELETE', body: { code: code.replace(/\s/g, '') } });
      setCode('');
      await reloadProfile();
      toast.ok('Verificación en dos pasos desactivada');
    });
  };

  const logoutAll = () =>
    run(async () => {
      const r = await api<{ revokedSessions: number }>('/auth/logout-all', { method: 'POST' });
      toast.info(`Se cerraron ${r.revokedSessions} sesión(es)`);
      await logout();
    });

  return (
    <div className="max-w-2xl">
      <PageHeader title="Mi cuenta" />

      <section className="card p-5">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="label">Nombre</dt>
            <dd>{fullName(user.firstName, user.lastName)}</dd>
          </div>
          <div>
            <dt className="label">Email</dt>
            <dd>{user.email}</dd>
          </div>
          <div>
            <dt className="label">Cuenta creada</dt>
            <dd>{formatDateTime(user.createdAt)}</dd>
          </div>
          <div>
            <dt className="label">Permisos vigentes</dt>
            <dd>{permissions.length}</dd>
          </div>
        </dl>
      </section>

      <section className="card mt-5 p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-semibold">Verificación en dos pasos (2FA)</h2>
          {user.mfaEnabled ? <Badge tone="ok">Activa</Badge> : <Badge tone="warn">Inactiva</Badge>}
        </div>
        <p className="mt-1 text-sm text-ink-soft">
          Código de 6 dígitos de una app autenticadora (TOTP) además de la contraseña. Es obligatoria para administradores.
        </p>

        {!user.mfaEnabled && !enrollment && (
          <button className="btn-primary mt-4" onClick={() => void startSetup()} disabled={busy}>
            Configurar 2FA
          </button>
        )}

        {enrollment && (
          <form onSubmit={activate} className="mt-4 space-y-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- data URL del QR que genera el API */}
            <img src={enrollment.qrCodeDataUrl} alt="Código QR para la app autenticadora" className="h-44 w-44 rounded border border-line" />
            <p className="text-xs text-ink-soft">
              Clave manual: <code className="font-mono select-all">{enrollment.secret}</code>
            </p>
            <CodeInput value={code} onChange={setCode} />
            <button className="btn-primary" disabled={busy}>Activar</button>
          </form>
        )}

        {user.mfaEnabled && (
          <form onSubmit={disable} className="mt-4 flex flex-wrap items-end gap-3">
            <div className="w-40">
              <CodeInput value={code} onChange={setCode} />
            </div>
            <button className="btn-ghost" disabled={busy}>Desactivar 2FA</button>
          </form>
        )}
        {error && <p className="mt-3 text-sm text-danger" role="alert">{error}</p>}
      </section>

      <section className="card mt-5 p-5">
        <h2 className="font-semibold">Sesiones</h2>
        <p className="mt-1 text-sm text-ink-soft">Cierra la sesión en todos los equipos y navegadores donde hayas ingresado.</p>
        <button className="btn-danger mt-4" onClick={() => void logoutAll()} disabled={busy}>
          Cerrar todas las sesiones
        </button>
      </section>
    </div>
  );
}

function CodeInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="label" htmlFor="mfa-code">Código de verificación</label>
      <input
        id="mfa-code"
        className="input font-mono tracking-[0.3em]"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9 ]{6,7}"
        maxLength={7}
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
