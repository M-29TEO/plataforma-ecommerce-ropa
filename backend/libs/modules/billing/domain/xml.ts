/**
 * Escritura de XML directamente en forma canónica (Canonical XML 1.0, W3C 2001): sin
 * declaración, etiquetas de apertura y cierre explícitas (nunca `<a/>`), atributos ordenados,
 * sin espacios entre elementos y escapes de C14N. Así el digest del comprobante y de las partes
 * de la firma XAdES es el SHA-1 de los mismos bytes que se escriben, sin una librería de C14N.
 */

export function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
}

export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#x9;')
    .replace(/\n/g, '&#xA;')
    .replace(/\r/g, '&#xD;');
}

export type Attrs = Record<string, string>;

/**
 * Elemento con hijos ya serializados (string) o texto. Los atributos se ordenan por nombre, que
 * es el orden de C14N para atributos sin espacio de nombres. `nsDecl` (declaraciones xmlns ya
 * ordenadas) va antes que los atributos, como exige C14N.
 */
export function el(name: string, content: string | string[] | null | undefined, attrs: Attrs = {}, nsDecl = ''): string {
  const attrText = Object.keys(attrs)
    .sort()
    .map((k) => ` ${k}="${escapeAttr(attrs[k])}"`)
    .join('');
  const body = Array.isArray(content) ? content.join('') : (content ?? '');
  return `<${name}${nsDecl}${attrText}>${body}</${name}>`;
}

/** Elemento de texto; null/undefined/'' = el elemento no se escribe (campos opcionales). */
export function leaf(name: string, value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  return el(name, escapeText(String(value)));
}
