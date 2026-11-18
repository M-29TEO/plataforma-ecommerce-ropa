/**
 * Lector de XML mínimo para las respuestas SOAP del SRI: elementos, atributos, texto y CDATA.
 * Ignora la declaración, comentarios e instrucciones de proceso; no admite DTD. Los prefijos de
 * espacio de nombres se descartan (localName), que es lo que interesa de una respuesta SOAP.
 */
export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? m;
  });
}

const local = (name: string) => name.slice(name.indexOf(':') + 1);

export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) stack[stack.length - 1].text += decode(xml.slice(i, lt));
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt);
      if (end < 0) throw new Error('CDATA sin cerrar');
      stack[stack.length - 1].text += xml.slice(lt + 9, end);
      i = end + 3;
    } else if (xml.startsWith('<!--', lt)) {
      i = xml.indexOf('-->', lt) + 3;
    } else if (xml.startsWith('<?', lt)) {
      i = xml.indexOf('?>', lt) + 2;
    } else if (xml.startsWith('<!', lt)) {
      throw new Error('DTD no admitida');
    } else if (xml[lt + 1] === '/') {
      const gt = xml.indexOf('>', lt);
      const name = local(xml.slice(lt + 2, gt).trim());
      const node = stack.pop();
      if (!node || node.name !== name) throw new Error(`Cierre inesperado </${name}>`);
      i = gt + 1;
    } else {
      const gt = xml.indexOf('>', lt);
      if (gt < 0) throw new Error('Etiqueta sin cerrar');
      const raw = xml.slice(lt + 1, gt);
      const selfClosing = raw.endsWith('/');
      const body = selfClosing ? raw.slice(0, -1) : raw;
      const nameEnd = body.search(/\s|$/);
      const node: XmlNode = { name: local(body.slice(0, nameEnd)), attrs: {}, children: [], text: '' };
      for (const m of body.slice(nameEnd).matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
        node.attrs[local(m[1])] = decode(m[3] ?? m[4] ?? '');
      }
      stack[stack.length - 1].children.push(node);
      if (!selfClosing) stack.push(node);
      i = gt + 1;
    }
  }
  if (stack.length !== 1) throw new Error(`Elemento sin cerrar: <${stack[stack.length - 1].name}>`);
  return root;
}

/** Primer descendiente con ese nombre (búsqueda en profundidad). */
export function find(node: XmlNode, name: string): XmlNode | undefined {
  for (const c of node.children) {
    if (c.name === name) return c;
    const deep = find(c, name);
    if (deep) return deep;
  }
  return undefined;
}

export function findAll(node: XmlNode, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    out.push(...findAll(c, name));
  }
  return out;
}

/** Texto (sin espacios de los extremos) del primer hijo directo con ese nombre. */
export function childText(node: XmlNode, name: string): string | null {
  const c = node.children.find((x) => x.name === name);
  return c ? c.text.trim() : null;
}
