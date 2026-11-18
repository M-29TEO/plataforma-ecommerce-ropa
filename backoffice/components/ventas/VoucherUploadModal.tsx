'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useToast } from '@/components/providers/ToastProvider';
import { Modal } from '@/components/ui/Modal';
import { api, errorMessage } from '@/lib/api/client';
import { voucherFileError } from '@/lib/assisted';

/**
 * Sube el comprobante de transferencia que el cliente envió (por WhatsApp) a un pedido asistido:
 * POST /assisted-orders/:orderId/transfer-voucher (multipart "file", "bankName", "reference").
 * El pago queda pendiente de verificación por Finanzas.
 */
export function VoucherUploadModal({ orderId, orderNumber, open, onClose }: { orderId: string; orderNumber: string; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [bankName, setBankName] = useState('');
  const [reference, setReference] = useState('');
  const [touched, setTouched] = useState(false);

  const fileError = voucherFileError(file);
  const bankError = bankName.trim() && bankName.trim().length < 2 ? 'Mínimo 2 caracteres.' : null;

  const upload = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.append('file', file!);
      if (bankName.trim()) form.append('bankName', bankName.trim());
      if (reference.trim()) form.append('reference', reference.trim());
      return api<{ status: string }>(`/assisted-orders/${orderId}/transfer-voucher`, { method: 'POST', form });
    },
    onSuccess: () => {
      toast.ok(`Comprobante del pedido ${orderNumber} enviado: queda por verificar.`);
      void qc.invalidateQueries({ queryKey: ['ventas', 'assisted-orders'] });
      void qc.invalidateQueries({ queryKey: ['orders'] });
      close();
    },
  });

  function close() {
    setFile(null);
    setBankName('');
    setReference('');
    setTouched(false);
    upload.reset();
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={`Subir comprobante · ${orderNumber}`}
      footer={
        <>
          <button type="button" className="btn-ghost" onClick={close} disabled={upload.isPending}>
            Cancelar
          </button>
          <button
            type="submit"
            form="voucher-form"
            className="btn-primary"
            disabled={upload.isPending}
          >
            {upload.isPending ? 'Subiendo…' : 'Subir comprobante'}
          </button>
        </>
      }
    >
      <form
        id="voucher-form"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (!fileError && !bankError) upload.mutate();
        }}
      >
        <div>
          <label htmlFor="v-file" className="label">
            Archivo (JPG, PNG o PDF, máx. 5 MB)
          </label>
          <input
            id="v-file"
            type="file"
            className="input"
            required
            accept="image/jpeg,image/png,application/pdf"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          {(touched || file) && fileError && <p className="mt-1 text-xs text-danger">{fileError}</p>}
        </div>
        <div>
          <label htmlFor="v-bank" className="label">
            Banco de origen (opcional)
          </label>
          <input id="v-bank" className="input" maxLength={80} value={bankName} onChange={(e) => setBankName(e.target.value)} />
          {bankError && <p className="mt-1 text-xs text-danger">{bankError}</p>}
        </div>
        <div>
          <label htmlFor="v-ref" className="label">
            Número de comprobante (opcional)
          </label>
          <input id="v-ref" className="input" maxLength={80} value={reference} onChange={(e) => setReference(e.target.value)} />
        </div>
        {upload.error && (
          <p className="text-sm text-danger" role="alert">
            {errorMessage(upload.error)}
          </p>
        )}
      </form>
    </Modal>
  );
}
