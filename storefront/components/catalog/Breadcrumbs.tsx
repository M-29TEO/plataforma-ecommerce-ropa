import Link from 'next/link';
import { SITE_URL } from '@/lib/config';

export interface Crumb {
  name: string;
  href: string;
}

/** Migas de pan visibles y como datos estructurados (BreadcrumbList) para los buscadores. */
export function Breadcrumbs({ items }: { items: Crumb[] }) {
  const all = [{ name: 'Inicio', href: '/' }, ...items];
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: all.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: `${SITE_URL}${c.href}` })),
  };
  return (
    <nav aria-label="Migas de pan" className="text-sm text-ink-soft">
      <ol className="flex flex-wrap items-center gap-1">
        {all.map((c, i) => (
          <li key={c.href} className="flex items-center gap-1">
            {i > 0 && <span aria-hidden>/</span>}
            {i === all.length - 1 ? (
              <span aria-current="page" className="text-ink">
                {c.name}
              </span>
            ) : (
              <Link href={c.href} className="hover:text-ink hover:underline">
                {c.name}
              </Link>
            )}
          </li>
        ))}
      </ol>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }} />
    </nav>
  );
}
