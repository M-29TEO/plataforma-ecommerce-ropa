'use client';

import { useCart } from '../providers/CartProvider';

export function CartButton() {
  const { count, setOpen } = useCart();
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="relative flex h-10 w-10 items-center justify-center rounded-full hover:bg-sand"
      aria-label={`Carrito, ${count} ${count === 1 ? 'producto' : 'productos'}`}
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5 fill-none stroke-current" strokeWidth="1.8" aria-hidden>
        <path d="M6 7h12l-1 13H7L6 7z" />
        <path d="M9 7a3 3 0 0 1 6 0" />
      </svg>
      {count > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-[11px] font-semibold text-white">
          {count}
        </span>
      )}
    </button>
  );
}
