'use client';

import { Modal } from '@/components/ui/Modal';

/** Confirmación de una acción destructiva o irreversible. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger = true,
  busy = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button className={danger ? 'btn-danger' : 'btn-primary'} onClick={onConfirm} disabled={busy}>
            {busy ? 'Procesando…' : confirmLabel}
          </button>
        </>
      }
    >
      <div className="space-y-2 text-sm">{children}</div>
    </Modal>
  );
}
