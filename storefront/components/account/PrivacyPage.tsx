'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, errorMessage, getAccessToken } from '@/lib/api/client';
import { BROWSER_API } from '@/lib/config';
import { useAuth } from '../providers/AuthProvider';
import { useToast } from '../providers/ToastProvider';

const CONFIRM = 'ELIMINAR MI CUENTA';

/** Derechos LOPDP: descargar mis datos (JSON) y eliminar la cuenta (anonimización). */
export function PrivacyPage() {
  const { logout } = useAuth();
  const toast = useToast();
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  async function download() {
    const res = await fetch(`${BROWSER_API}/me/privacy/export`, { headers: { Authorization: `Bearer ${getAccessToken()}` }, credentials: 'include' });
    if (!res.ok) {
      toast('No pudimos generar tu archivo. Intenta de nuevo.', 'error');
      return;
    }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mis-datos.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function anonymize(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/me/privacy/anonymize', { method: 'POST', body: { password, confirm } });
      await logout();
      toast('Eliminamos tus datos personales. Gracias por haber sido parte.', 'ok');
      router.replace('/');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <h1 className="text-3xl">Privacidad y tus datos</h1>
      <div className="card p-5">
        <h2 className="font-sans text-base font-semibold">Descargar mis datos</h2>
        <p className="mt-1 text-sm text-ink-soft">Un archivo con tu perfil, direcciones, pedidos, reseñas y consentimientos (Ley Orgánica de Protección de Datos Personales).</p>
        <button type="button" className="btn-ghost mt-3" onClick={() => void download()}>
          Descargar (JSON)
        </button>
      </div>
      <form onSubmit={anonymize} className="card space-y-3 border-danger/40 p-5">
        <h2 className="font-sans text-base font-semibold text-danger">Eliminar mi cuenta</h2>
        <p className="text-sm text-ink-soft">Borramos tus datos personales. Las facturas se conservan el tiempo que exige la ley tributaria, sin tu información de contacto. No se puede deshacer.</p>
        <div>
          <label className="label" htmlFor="pw">
            Tu contraseña
          </label>
          <input id="pw" type="password" autoComplete="current-password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        <div>
          <label className="label" htmlFor="confirm">
            Escribe «{CONFIRM}» para confirmar
          </label>
          <input id="confirm" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </div>
        <button className="btn bg-danger text-white hover:bg-danger/90" disabled={busy || confirm !== CONFIRM || !password}>
          Eliminar definitivamente
        </button>
      </form>
    </div>
  );
}
