'use client';

import { useState } from 'react';
import { BarcodeScanner } from '@/components/scanner/BarcodeScanner';
import { Modal } from '@/components/ui/Modal';

/** Botón "Escanear": abre la cámara (o un lector USB) y entrega el código leído. */
export function ScanButton({ onCode, disabled = false, label = 'Escanear' }: { onCode: (code: string) => void; disabled?: boolean; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(true)} disabled={disabled} title="Leer el código de barras con la cámara o un lector">
        {label}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Escanear código de barras">
        <BarcodeScanner
          active={open}
          label="Código de barras"
          onDetected={(code) => {
            onCode(code);
            setOpen(false);
          }}
        />
      </Modal>
    </>
  );
}
