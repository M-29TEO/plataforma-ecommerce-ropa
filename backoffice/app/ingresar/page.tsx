'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { useAuth } from '@/components/providers/AuthProvider';
import { errorMessage, isApiError } from '@/lib/api/client';
import { APP_NAME } from '@/lib/config';
import { safeNext } from '@/lib/safe-redirect';
import type { MfaEnrollment } from '@/lib/types';

type Step = { kind: 'password' } | { kind: 'mfa'; mfaToken: string } | { kind: 'mfa-setup'; mfaToken: string; enrollment: MfaEnrollment | null };

/**
 * Ingreso del personal en dos pasos: contraseña y, si la cuenta tiene 2FA, el código TOTP de la app
 * autenticadora. El admin SIEMPRE usa 2FA: si aún no lo configuró, aquí mismo escanea el QR y
 * confirma con el primer código antes de entrar (el API no le abre sesión sin eso).
 */
function LoginForm() {
  const { status, login, loginMfa, setupMfa, activateMfa } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get('next'));
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status === 'authenticated') router.replace(next);
  }, [status, next, router]);

  const restart = (message: string) => {
    setStep({ kind: 'password' });
    setCode('');
    setError(message);
  };

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      // El mfaToken dura 5 min: si venció, se vuelve a pedir la contraseña.
      if (isApiError(e, 'MFA_TOKEN_INVALID')) restart(errorMessage(e));
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const submitPassword = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await login(email, password);
      setPassword('');
      if (r.kind === 'mfa') setStep({ kind: 'mfa', mfaToken: r.mfaToken });
      if (r.kind === 'mfa-setup') {
        setStep({ kind: 'mfa-setup', mfaToken: r.mfaToken, enrollment: null });
        const enrollment = await setupMfa(r.mfaToken);
        setStep({ kind: 'mfa-setup', mfaToken: r.mfaToken, enrollment });
      }
    });
  };

  const submitCode = (e: React.FormEvent) => {
    e.preventDefault();
    if (step.kind === 'password') return;
    const clean = code.replace(/\s/g, '');
    void run(async () => {
      if (step.kind === 'mfa') await loginMfa(step.mfaToken, clean);
      else await activateMfa(step.mfaToken, clean);
    });
  };

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="card w-full max-w-sm p-6 shadow-sm">
        <p className="text-xs font-semibold tracking-widest text-accent uppercase">Backoffice</p>
        <h1 className="mt-1 mb-5 text-xl font-semibold">{APP_NAME}</h1>

        {step.kind === 'password' && (
          <form onSubmit={submitPassword} className="space-y-4">
            <div>
              <label className="label" htmlFor="email">Email</label>
              <input id="email" className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="password">Contraseña</label>
              <input id="password" className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            {error && <p className="text-sm text-danger" role="alert">{error}</p>}
            <button className="btn-primary w-full" disabled={busy}>{busy ? 'Verificando…' : 'Ingresar'}</button>
          </form>
        )}

        {step.kind !== 'password' && (
          <form onSubmit={submitCode} className="space-y-4">
            {step.kind === 'mfa' ? (
              <p className="text-sm text-ink-soft">Escribe el código de 6 dígitos de tu app autenticadora.</p>
            ) : (
              <div className="space-y-3 text-sm">
                <p className="font-medium">Tu rol exige verificación en dos pasos (2FA).</p>
                <p className="text-ink-soft">
                  Escanea el código con una app autenticadora libre (por ejemplo Aegis, FreeOTP o KeePassXC) y escribe el primer código.
                </p>
                {step.enrollment ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element -- data URL del QR que genera el API */}
                    <img src={step.enrollment.qrCodeDataUrl} alt="Código QR para la app autenticadora" className="mx-auto h-48 w-48 rounded border border-line" />
                    <details className="text-xs text-ink-soft">
                      <summary className="cursor-pointer">¿No puedes escanear? Ingresa la clave a mano</summary>
                      <code className="mt-2 block font-mono break-all select-all">{step.enrollment.secret}</code>
                    </details>
                  </>
                ) : (
                  <p className="text-ink-soft">Generando el código QR…</p>
                )}
              </div>
            )}
            <div>
              <label className="label" htmlFor="code">Código de verificación</label>
              <input
                id="code"
                className="input text-center font-mono text-lg tracking-[0.4em]"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9 ]{6,7}"
                maxLength={7}
                required
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </div>
            {error && <p className="text-sm text-danger" role="alert">{error}</p>}
            <button className="btn-primary w-full" disabled={busy || (step.kind === 'mfa-setup' && !step.enrollment)}>
              {busy ? 'Verificando…' : step.kind === 'mfa' ? 'Verificar' : 'Activar 2FA e ingresar'}
            </button>
            <button type="button" className="btn-ghost w-full" onClick={() => restart('')}>Volver</button>
          </form>
        )}
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
