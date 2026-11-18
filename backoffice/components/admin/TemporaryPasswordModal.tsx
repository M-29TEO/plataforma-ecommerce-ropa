'use client';

import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';

/**
 * Muestra la contraseña temporal UNA sola vez (el servidor no la guarda en claro y no la vuelve a
 * entregar). Se cierra solo con el botón explícito para no perderla por un clic fuera.
 */
export function TemporaryPasswordModal({
  password,
  email,
  mfaRequired,
  onClose,
}: {
  password: string | null;
  email: string;
  mfaRequired?: boolean;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!password) return;
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  function close() {
    setCopied(false);
    onClose();
  }

  return (
    <Modal
      open={!!password}
      onClose={close}
      title="Contraseña temporal"
      size="sm"
      footer={
        <button className="btn-primary" onClick={close}>
          Ya la guardé
        </button>
      }
    >
      <div className="space-y-3 text-sm">
        <p>
          Entrégala a <strong>{email}</strong> por un canal seguro. Deberá cambiarla en su primer ingreso.
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 rounded-md border border-line bg-sand px-3 py-2 font-mono text-base break-all select-all" aria-label="Contraseña temporal">
            {password}
          </code>
          <button className="btn-ghost" onClick={() => void copy()}>
            {copied ? 'Copiada' : 'Copiar'}
          </button>
        </div>
        <p className="rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-warn" role="alert">
          No se volverá a mostrar. Si se pierde, tendrás que generar otra.
        </p>
        {mfaRequired && (
          <p className="text-ink-soft">
            Tiene el rol Administrador: en su primer ingreso deberá configurar la verificación en dos pasos (2FA) con una app autenticadora.
          </p>
        )}
      </div>
    </Modal>
  );
}
