/** Trazos de la firma: listas de puntos en coordenadas del lienzo. */
export type Stroke = Array<{ x: number; y: number }>;

const r = (n: number) => Math.round(n * 10) / 10;

/** Path SVG de un trazo (un toque sin moverse queda como un punto visible). */
export function strokeToPath(stroke: Stroke): string {
  if (stroke.length === 0) return '';
  const [first, ...rest] = stroke;
  if (rest.length === 0) return `M${r(first.x)},${r(first.y)} l0.1,0.1`;
  return `M${r(first.x)},${r(first.y)} ${rest.map((p) => `L${r(p.x)},${r(p.y)}`).join(' ')}`;
}

/** Largo total dibujado: una firma de verdad no es un punto ni una raya mínima. */
export function inkLength(strokes: Stroke[]): number {
  let total = 0;
  for (const s of strokes) {
    for (let i = 1; i < s.length; i++) total += Math.hypot(s[i].x - s[i - 1].x, s[i].y - s[i - 1].y);
  }
  return total;
}

export const MIN_SIGNATURE_INK = 80;

export function isSignatureComplete(strokes: Stroke[]): boolean {
  return inkLength(strokes) >= MIN_SIGNATURE_INK;
}
