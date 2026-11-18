import Link from 'next/link';
import { catalog } from '@/lib/api/server';
import { STORE_NAME } from '@/lib/config';
import type { CategoryNode } from '@/lib/types';
import { AccountLink } from './AccountLink';
import { CartButton } from './CartButton';
import { MobileMenu } from './MobileMenu';
import { SearchBox } from './SearchBox';

export interface NavGroup {
  name: string;
  path: string;
  children: Array<{ name: string; path: string }>;
}

/** Categorías raíz con sus subcategorías (solo las que tienen productos). */
export function navGroups(categories: CategoryNode[]): NavGroup[] {
  return categories
    .filter((c) => c.parentPath === null && c.productCount > 0)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((root) => ({
      name: root.name,
      path: root.path,
      children: categories
        .filter((c) => c.parentPath === root.path && c.productCount > 0)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((c) => ({ name: c.name, path: c.path })),
    }));
}

export async function Header() {
  // El menú se regenera con el mismo ISR del catálogo; si el API no responde, la tienda sigue sin menú.
  const groups = await catalog
    .categories()
    .then(navGroups)
    .catch(() => [] as NavGroup[]);

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-paper/95 backdrop-blur">
      <div className="bg-ink py-1.5 text-center text-xs text-paper">Envío gratis desde $50 · Entregas el mismo día en Quito</div>
      <div className="container-page flex h-16 items-center gap-4">
        <MobileMenu groups={groups} />
        <Link href="/" className="font-display text-xl font-semibold tracking-tight">
          {STORE_NAME}
        </Link>
        <nav aria-label="Categorías" className="hidden lg:block">
          <ul className="flex items-center gap-1">
            {groups.map((g) => (
              <li key={g.path} className="group relative">
                <Link href={`/categoria/${g.path}`} className="rounded-full px-3 py-2 text-sm hover:bg-sand">
                  {g.name}
                </Link>
                {g.children.length > 0 && (
                  <div className="invisible absolute left-0 top-full w-56 pt-2 opacity-0 transition group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
                    <ul className="card p-2 shadow-lg">
                      {g.children.map((c) => (
                        <li key={c.path}>
                          <Link href={`/categoria/${c.path}`} className="block rounded-lg px-3 py-2 text-sm hover:bg-sand">
                            {c.name}
                          </Link>
                        </li>
                      ))}
                      <li>
                        <Link href={`/categoria/${g.path}`} className="block rounded-lg px-3 py-2 text-sm font-medium hover:bg-sand">
                          Ver todo {g.name}
                        </Link>
                      </li>
                    </ul>
                  </div>
                )}
              </li>
            ))}
            <li>
              <Link href="/ofertas" className="rounded-full px-3 py-2 text-sm font-medium text-accent-dark hover:bg-sand">
                Ofertas
              </Link>
            </li>
          </ul>
        </nav>
        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          <SearchBox />
          <AccountLink />
          <CartButton />
        </div>
      </div>
    </header>
  );
}
