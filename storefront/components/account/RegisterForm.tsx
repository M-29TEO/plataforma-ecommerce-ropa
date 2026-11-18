'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { errorMessage, isApiError } from '@/lib/api/client';
import { safeRedirect } from '@/lib/safe-redirect';
import { useAuth } from '../providers/AuthProvider';

/** Registro con los consentimientos de la LOPDP: términos y privacidad obligatorios; marketing por canal, opcional. */
export function RegisterForm() {
  const { register } = useAuth();
  const router = useRouter();
  const next = safeRedirect(useSearchParams().get('volver'));
  const [f, setF] = useState({ firstName: '', lastName: '', email: '', phone: '', password: '' });
  const [consents, setConsents] = useState({ terms: false, privacy: false, marketingEmail: false, marketingWhatsapp: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((v) => ({ ...v, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!consents.terms || !consents.privacy) {
      setError('Debes aceptar los términos y la política de privacidad.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await register({
        firstName: f.firstName.trim(),
        lastName: f.lastName.trim(),
        email: f.email.trim(),
        phone: f.phone.replace(/[\s-]/g, ''),
        password: f.password,
        consents,
      });
      router.replace(next);
    } catch (err) {
      if (isApiError(err, 'EMAIL_TAKEN')) setError('Ya existe una cuenta con ese correo. ¿Quieres ingresar?');
      else if (isApiError(err, 'PASSWORD_TOO_SHORT')) setError(err.message);
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-4">
      {error && (
        <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="firstName">
            Nombre
          </label>
          <input id="firstName" autoComplete="given-name" required maxLength={100} className="input" value={f.firstName} onChange={set('firstName')} />
        </div>
        <div>
          <label className="label" htmlFor="lastName">
            Apellido
          </label>
          <input id="lastName" autoComplete="family-name" required maxLength={100} className="input" value={f.lastName} onChange={set('lastName')} />
        </div>
      </div>
      <div>
        <label className="label" htmlFor="email">
          Correo
        </label>
        <input id="email" type="email" autoComplete="email" required className="input" value={f.email} onChange={set('email')} />
      </div>
      <div>
        <label className="label" htmlFor="phone">
          Celular
        </label>
        <input id="phone" type="tel" autoComplete="tel" required placeholder="0991234567" pattern="\+?[0-9\s-]{7,18}" className="input" value={f.phone} onChange={set('phone')} />
      </div>
      <div>
        <label className="label" htmlFor="password">
          Contraseña
        </label>
        <input id="password" type="password" autoComplete="new-password" required minLength={10} className="input" value={f.password} onChange={set('password')} aria-describedby="pw-help" />
        <p id="pw-help" className="mt-1 text-xs text-ink-soft">
          Al menos 10 caracteres. Una frase fácil de recordar funciona bien.
        </p>
      </div>
      <fieldset className="space-y-2 text-sm">
        <legend className="sr-only">Consentimientos</legend>
        <label className="flex gap-2">
          <input type="checkbox" className="mt-1 accent-ink" checked={consents.terms} onChange={(e) => setConsents((c) => ({ ...c, terms: e.target.checked }))} />
          <span>Acepto los términos y condiciones de compra.</span>
        </label>
        <label className="flex gap-2">
          <input type="checkbox" className="mt-1 accent-ink" checked={consents.privacy} onChange={(e) => setConsents((c) => ({ ...c, privacy: e.target.checked }))} />
          <span>Acepto el tratamiento de mis datos según la política de privacidad (LOPDP).</span>
        </label>
        <label className="flex gap-2 text-ink-soft">
          <input type="checkbox" className="mt-1 accent-ink" checked={consents.marketingEmail} onChange={(e) => setConsents((c) => ({ ...c, marketingEmail: e.target.checked }))} />
          <span>Quiero recibir novedades y ofertas por correo (opcional).</span>
        </label>
        <label className="flex gap-2 text-ink-soft">
          <input type="checkbox" className="mt-1 accent-ink" checked={consents.marketingWhatsapp} onChange={(e) => setConsents((c) => ({ ...c, marketingWhatsapp: e.target.checked }))} />
          <span>Quiero recibir ofertas por WhatsApp (opcional).</span>
        </label>
      </fieldset>
      <button className="btn-primary w-full py-3" disabled={busy}>
        {busy ? 'Creando tu cuenta…' : 'Crear cuenta'}
      </button>
      <p className="text-center text-sm text-ink-soft">
        ¿Ya tienes cuenta?{' '}
        <Link href={`/ingresar?volver=${encodeURIComponent(next)}`} className="underline">
          Ingresa
        </Link>
      </p>
    </form>
  );
}
