'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { errorMessage, isApiError } from '@/lib/api/client';
import type { MfaChallenge } from '@/lib/commerce-types';
import { safeRedirect } from '@/lib/safe-redirect';
import { useAuth } from '../providers/AuthProvider';

export function LoginForm() {
  const { login, loginMfa, status } = useAuth();
  const router = useRouter();
  const next = safeRedirect(useSearchParams().get('volver'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [mfa, setMfa] = useState<MfaChallenge | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status === 'authenticated') router.replace(next);
  }, [status, next, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mfa) {
        await loginMfa(mfa.mfaToken, code);
      } else {
        const challenge = await login(email.trim(), password);
        if (challenge?.mfaSetupRequired) {
          setError('Esta cuenta necesita configurar el segundo factor desde el backoffice.');
          return;
        }
        if (challenge) {
          setMfa(challenge);
          return;
        }
      }
      router.replace(next);
    } catch (err) {
      if (isApiError(err, 'INVALID_CREDENTIALS')) setError('Correo o contraseña incorrectos.');
      else if (isApiError(err, 'ACCOUNT_LOCKED')) setError('Bloqueamos la cuenta unos minutos por varios intentos fallidos. Vuelve a intentar más tarde.');
      else if (isApiError(err, 'INVALID_MFA_CODE')) setError('El código no es correcto.');
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
      {error && (
        <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      {mfa ? (
        <div>
          <label className="label" htmlFor="code">
            Código de tu app de autenticación
          </label>
          <input id="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} className="input text-center text-lg tracking-[0.4em]" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />
        </div>
      ) : (
        <>
          <div>
            <label className="label" htmlFor="email">
              Correo
            </label>
            <input id="email" type="email" autoComplete="email" required className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="password">
              Contraseña
            </label>
            <input id="password" type="password" autoComplete="current-password" required className="input" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
        </>
      )}
      <button className="btn-primary w-full py-3" disabled={busy}>
        {busy ? 'Ingresando…' : mfa ? 'Verificar' : 'Ingresar'}
      </button>
      <p className="text-center text-sm text-ink-soft">
        ¿No tienes cuenta?{' '}
        <Link href={`/registro?volver=${encodeURIComponent(next)}`} className="underline">
          Crea una
        </Link>
      </p>
      <p className="text-center text-xs text-ink-soft">También puedes comprar como invitado desde el carrito.</p>
    </form>
  );
}
