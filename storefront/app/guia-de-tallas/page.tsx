import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Guía de tallas',
  description: 'Cómo medirte para elegir tu talla: busto, cintura, cadera y entrepierna. Cada producto tiene su propia tabla de medidas.',
};

export default function GuiaDeTallas() {
  return (
    <article className="container-page max-w-3xl py-12">
      <h1 className="text-4xl">Guía de tallas</h1>
      <p className="mt-4 text-ink-soft">Cada producto tiene su tabla de medidas en la ficha («Guía de tallas», junto al selector de talla), porque el calce cambia según la prenda y la marca. Además te mostramos qué opinan quienes ya lo compraron: si suele quedar pequeño, justo o grande.</p>
      <h2 className="mt-8 text-2xl">Cómo medirte</h2>
      <ul className="mt-3 list-disc space-y-2 pl-5 text-ink-soft">
        <li>Usa una cinta métrica flexible, sobre ropa interior o una prenda delgada.</li>
        <li>Busto o pecho: alrededor de la parte más llena, con la cinta horizontal.</li>
        <li>Cintura: en la parte más angosta, sin apretar.</li>
        <li>Cadera: alrededor de la parte más ancha, con los pies juntos.</li>
        <li>Entrepierna: del centro de la entrepierna hasta el tobillo.</li>
      </ul>
      <p className="mt-6 text-ink-soft">¿Entre dos tallas? Elige la mayor para un calce más holgado. Tienes 30 días para cambiarla.</p>
    </article>
  );
}
