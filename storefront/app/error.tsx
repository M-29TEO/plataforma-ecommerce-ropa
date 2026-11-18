'use client';

export default function Error({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <div className="container-page py-24 text-center">
      <h1 className="text-3xl">Algo salió mal</h1>
      <p className="mt-3 text-ink-soft">No pudimos cargar esta página. Puede ser un problema momentáneo.</p>
      <button type="button" className="btn-primary mt-8" onClick={() => retry()}>
        Intentar de nuevo
      </button>
    </div>
  );
}
