/**
 * Código de barras Code 128 para la clave de acceso del RIDE. Se codifica en el subconjunto C
 * (dos dígitos por símbolo); como la clave tiene 49 dígitos (impar), el último va en el
 * subconjunto B tras el símbolo CODE B (100).
 *
 * Cada patrón son 6 anchos (barra, espacio, barra...) que suman 11 módulos; el de parada tiene 7
 * anchos y suma 13.
 */
export const CODE128_PATTERNS: readonly string[] = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

const START_C = 105;
const CODE_B = 100;
const STOP = 106;

/** Valores de los símbolos, con el de inicio, el dígito de control y el de parada. */
export function code128Values(digits: string): number[] {
  if (!/^\d+$/.test(digits)) throw new Error('Code 128C solo codifica dígitos');
  const values = [START_C];
  const pairs = digits.length - (digits.length % 2);
  for (let i = 0; i < pairs; i += 2) values.push(Number(digits.slice(i, i + 2)));
  if (digits.length % 2) values.push(CODE_B, digits.charCodeAt(digits.length - 1) - 32);
  const checksum = values.reduce((sum, v, i) => sum + v * (i === 0 ? 1 : i), 0) % 103;
  return [...values, checksum, STOP];
}

/** Barras como [inicio, ancho] en módulos, y el ancho total del código. */
export function code128Bars(digits: string): { bars: [number, number][]; modules: number } {
  const bars: [number, number][] = [];
  let x = 0;
  for (const v of code128Values(digits)) {
    [...CODE128_PATTERNS[v]].forEach((w, i) => {
      if (i % 2 === 0) bars.push([x, Number(w)]);
      x += Number(w);
    });
  }
  return { bars, modules: x };
}
