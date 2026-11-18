// XML para el SRI simulado, sin dependencias: un parser que conserva prefijos y declaraciones de
// espacios de nombres, y Canonical XML 1.0 inclusivo (W3C 2001, sin comentarios) de un subárbol,
// que es lo que exige verificar una firma XMLDSig/XAdES. Es independiente del código del backend:
// si el backend canonicaliza mal, este verificador lo detecta.

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export class XmlError extends Error {}

function decode(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    if (!(e in ENTITIES)) throw new XmlError(`Entidad desconocida: ${m}`);
    return ENTITIES[e];
  });
}

const NAME = /^[A-Za-z_][\w.-]*(:[A-Za-z_][\w.-]*)?$/;

/**
 * Nodo elemento: { type: 'element', name, prefix, local, attrs: [{ name, prefix, local, value }],
 * nsDecls: { prefix|'' : uri }, children: [...], parent, ns (URI del elemento) }.
 * Nodo texto: { type: 'text', value }. Se ignoran comentarios, instrucciones de proceso y la
 * declaración XML. No se admiten DTD.
 */
export function parseXml(input) {
  const xml = String(input).replace(/\r\n?/g, '\n'); // normalización de fin de línea (XML 1.0 §2.11)
  const doc = { type: 'document', children: [] };
  const stack = [doc];
  let i = 0;
  const top = () => stack[stack.length - 1];
  const pushText = (value) => {
    if (!value) return;
    if (top() === doc) {
      if (value.trim()) throw new XmlError('Texto fuera del elemento raíz');
      return;
    }
    const last = top().children[top().children.length - 1];
    if (last?.type === 'text') last.value += value;
    else top().children.push({ type: 'text', value });
  };

  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      pushText(decode(xml.slice(i)));
      break;
    }
    if (lt > i) pushText(decode(xml.slice(i, lt)));
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt);
      if (end < 0) throw new XmlError('CDATA sin cerrar');
      pushText(xml.slice(lt + 9, end));
      i = end + 3;
    } else if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt);
      if (end < 0) throw new XmlError('Comentario sin cerrar');
      i = end + 3;
    } else if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt);
      if (end < 0) throw new XmlError('Instrucción de proceso sin cerrar');
      i = end + 2;
    } else if (xml.startsWith('<!', lt)) {
      throw new XmlError('DTD no admitida');
    } else if (xml[lt + 1] === '/') {
      const gt = xml.indexOf('>', lt);
      if (gt < 0) throw new XmlError('Etiqueta de cierre sin terminar');
      const name = xml.slice(lt + 2, gt).trim();
      const node = stack.pop();
      if (!node || node.type !== 'element' || node.name !== name) throw new XmlError(`Cierre inesperado </${name}>`);
      i = gt + 1;
    } else {
      // Busca el ">" que cierra la etiqueta respetando comillas de los atributos.
      let j = lt + 1;
      let quote = null;
      for (; j < xml.length; j++) {
        const c = xml[j];
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
      }
      if (j >= xml.length) throw new XmlError('Etiqueta sin cerrar');
      let raw = xml.slice(lt + 1, j);
      const selfClosing = raw.endsWith('/');
      if (selfClosing) raw = raw.slice(0, -1);
      const nameMatch = /^[^\s]+/.exec(raw);
      if (!nameMatch || !NAME.test(nameMatch[0])) throw new XmlError(`Nombre de elemento inválido: ${nameMatch?.[0] ?? ''}`);
      const node = { type: 'element', name: nameMatch[0], attrs: [], nsDecls: {}, children: [], parent: top() === doc ? null : top() };
      const rest = raw.slice(nameMatch[0].length);
      const attrRe = /\s+([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/gy;
      let consumed = 0;
      let m;
      while ((m = attrRe.exec(rest))) {
        consumed = attrRe.lastIndex;
        const aname = m[1];
        // Normalización de valores de atributo: los espacios literales pasan a ' '.
        const value = decode((m[3] ?? m[4]).replace(/[\t\n]/g, ' '));
        if (aname === 'xmlns') node.nsDecls[''] = value;
        else if (aname.startsWith('xmlns:')) node.nsDecls[aname.slice(6)] = value;
        else {
          if (node.attrs.some((a) => a.name === aname)) throw new XmlError(`Atributo repetido: ${aname}`);
          node.attrs.push({ name: aname, value });
        }
      }
      if (rest.slice(consumed).trim()) throw new XmlError(`Atributos mal formados en <${node.name}>`);
      if (top() === doc && doc.children.some((c) => c.type === 'element')) throw new XmlError('Más de un elemento raíz');
      top().children.push(node);
      if (!selfClosing) stack.push(node);
      i = j + 1;
    }
  }
  if (stack.length !== 1) throw new XmlError(`Elemento sin cerrar: <${top().name}>`);
  const root = doc.children.find((c) => c.type === 'element');
  if (!root) throw new XmlError('Documento sin elemento raíz');
  resolveNamespaces(root, { xml: 'http://www.w3.org/XML/1998/namespace' });
  return root;
}

function split(qname) {
  const i = qname.indexOf(':');
  return i < 0 ? { prefix: '', local: qname } : { prefix: qname.slice(0, i), local: qname.slice(i + 1) };
}

function resolveNamespaces(node, inherited) {
  const scope = { ...inherited, ...node.nsDecls };
  node.scope = scope;
  const { prefix, local } = split(node.name);
  if (prefix && !(prefix in scope)) throw new XmlError(`Prefijo no declarado: ${prefix}`);
  Object.assign(node, { prefix, local, ns: scope[prefix] ?? '' });
  for (const a of node.attrs) {
    const s = split(a.name);
    if (s.prefix && !(s.prefix in scope)) throw new XmlError(`Prefijo no declarado: ${s.prefix}`);
    Object.assign(a, { prefix: s.prefix, local: s.local, ns: s.prefix ? scope[s.prefix] : '' });
  }
  for (const c of node.children) if (c.type === 'element') resolveNamespaces(c, scope);
}

// ------------------------------------------------------------------ navegación

export const elements = (node) => node.children.filter((c) => c.type === 'element');
export const child = (node, local) => elements(node).find((c) => c.local === local);
export const childrenNamed = (node, local) => elements(node).filter((c) => c.local === local);
export const textOf = (node) => (node ? node.children.filter((c) => c.type === 'text').map((c) => c.value).join('') : null);
export const childText = (node, local) => {
  const c = node && child(node, local);
  return c ? textOf(c).trim() : null;
};

export function* walk(node) {
  yield node;
  for (const c of elements(node)) yield* walk(c);
}

export function findById(root, id) {
  for (const n of walk(root)) if (n.attrs.some((a) => (a.local === 'Id' || a.local === 'id') && a.value === id)) return n;
  return null;
}

// ------------------------------------------------------------------ Canonical XML 1.0 (inclusivo)

const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
const escAttr = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\t/g, '&#x9;').replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;');

/**
 * Forma canónica del subárbol de `node` como subconjunto del documento. En el elemento apex se
 * escriben TODAS las declaraciones de espacio de nombres en alcance (heredadas incluidas); en los
 * descendientes, solo las que cambian respecto del ancestro escrito. `exclude` omite un nodo y su
 * subárbol (transformación enveloped-signature).
 */
export function canonicalize(node, exclude = null) {
  const out = [];
  const render = (el, rendered) => {
    if (el === exclude) return;
    const decls = [];
    const now = { ...rendered };
    for (const [prefix, uri] of Object.entries(el.scope)) {
      if (prefix === 'xml') continue;
      if (prefix === '' && uri === '' && !rendered['']) continue; // xmlns="" solo si deshace un default
      if (rendered[prefix] !== uri) {
        decls.push([prefix, uri]);
        now[prefix] = uri;
      }
    }
    decls.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const attrs = [...el.attrs].sort((a, b) => (a.ns === b.ns ? (a.local < b.local ? -1 : a.local > b.local ? 1 : 0) : a.ns < b.ns ? -1 : 1));
    out.push(`<${el.name}`);
    for (const [prefix, uri] of decls) out.push(prefix ? ` xmlns:${prefix}="${escAttr(uri)}"` : ` xmlns="${escAttr(uri)}"`);
    for (const a of attrs) out.push(` ${a.name}="${escAttr(a.value)}"`);
    out.push('>');
    for (const c of el.children) {
      if (c.type === 'text') out.push(escText(c.value));
      else render(c, now);
    }
    out.push(`</${el.name}>`);
  };
  render(node, {});
  return out.join('');
}
