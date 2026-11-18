/** Muestra de color (cuadrito con el hex) o un recuadro punteado si el color no tiene hex. */
export function Swatch({ hex }: { hex: string | null | undefined }) {
  return hex ? (
    <span className="inline-block h-4 w-4 shrink-0 rounded-sm border border-line" style={{ backgroundColor: hex }} aria-hidden />
  ) : (
    <span className="inline-block h-4 w-4 shrink-0 rounded-sm border border-dashed border-line" aria-hidden />
  );
}
