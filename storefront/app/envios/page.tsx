import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Envíos y entregas',
  description: 'Entrega con motorizado el mismo día en Quito, courier a todo Ecuador, franjas horarias y seguimiento en vivo.',
};

export default function Envios() {
  return (
    <article className="container-page max-w-3xl py-12">
      <h1 className="text-4xl">Envíos y entregas</h1>
      <div className="mt-6 space-y-6 leading-relaxed text-ink-soft">
        <section>
          <h2 className="text-xl text-ink">Motorizado en Quito</h2>
          <p className="mt-2">En el checkout marcas tu dirección en el mapa y eliges una franja horaria. El costo depende de la distancia desde nuestra bodega. Cuando el motorizado sale, puedes verlo moverse en el mapa en tiempo real.</p>
        </section>
        <section>
          <h2 className="text-xl text-ink">Courier a todo el país</h2>
          <p className="mt-2">Fuera de nuestras zonas de reparto enviamos por courier. Te mostramos el precio y el tiempo estimado antes de pagar.</p>
        </section>
        <section>
          <h2 className="text-xl text-ink">Pago contra entrega</h2>
          <p className="mt-2">Disponible con motorizado: pagas en efectivo al recibir.</p>
        </section>
      </div>
    </article>
  );
}
