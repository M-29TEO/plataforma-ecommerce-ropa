import Link from 'next/link';

/** Título de pantalla con migas opcionales y acciones a la derecha. */
export function PageHeader({
  title,
  description,
  back,
  actions,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  back?: { href: string; label: string };
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {back && (
          <Link href={back.href} className="mb-1 inline-block text-xs text-ink-soft hover:text-ink">
            ← {back.label}
          </Link>
        )}
        <h1 className="text-xl font-semibold">{title}</h1>
        {description && <p className="mt-0.5 text-sm text-ink-soft">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
