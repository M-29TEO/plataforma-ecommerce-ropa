import Link from 'next/link';
import { STORE_NAME } from '@/lib/config';
import { InstallAppButton } from '../pwa/InstallAppButton';

export function Footer() {
  return (
    <footer className="mt-20 border-t border-line bg-sand/60">
      <div className="container-page grid gap-8 py-12 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <p className="font-display text-lg">{STORE_NAME}</p>
          <p className="mt-2 text-sm text-ink-soft">Moda diseñada y confeccionada en Ecuador. Precios en dólares con IVA incluido.</p>
          <div className="mt-4">
            <InstallAppButton />
          </div>
        </div>
        <div>
          <p className="text-sm font-semibold">Comprar</p>
          <ul className="mt-3 space-y-2 text-sm text-ink-soft">
            <li><Link href="/categoria/mujer">Mujer</Link></li>
            <li><Link href="/categoria/hombre">Hombre</Link></li>
            <li><Link href="/categoria/unisex">Unisex</Link></li>
            <li><Link href="/ofertas">Ofertas</Link></li>
          </ul>
        </div>
        <div>
          <p className="text-sm font-semibold">Ayuda</p>
          <ul className="mt-3 space-y-2 text-sm text-ink-soft">
            <li><Link href="/mi-cuenta/pedidos">Mis pedidos</Link></li>
            <li><Link href="/guia-de-tallas">Guía de tallas</Link></li>
            <li><Link href="/envios">Envíos y entregas</Link></li>
          </ul>
        </div>
        <div>
          <p className="text-sm font-semibold">Tus datos</p>
          <ul className="mt-3 space-y-2 text-sm text-ink-soft">
            <li><Link href="/mi-cuenta/privacidad">Privacidad (LOPDP)</Link></li>
            <li>Pagos simulados con fines académicos</li>
          </ul>
        </div>
      </div>
      <p className="border-t border-line py-4 text-center text-xs text-ink-soft">© {new Date().getFullYear()} {STORE_NAME} · Mapas © colaboradores de OpenStreetMap</p>
    </footer>
  );
}
