// Reglas del SRI simulado: estructura de la factura (01) y de la nota de crédito (04) (ficha técnica,
// esquema offline), clave de acceso, identificación del comprador, cuadre de totales y firma XAdES-BES.
import { createHash, verify as verifySignatureValue, X509Certificate } from 'node:crypto';
import { canonicalize, child, childrenNamed, childText, elements, findById, textOf, walk } from './xml.mjs';

/** Mensajes del catálogo de errores del SRI que usa el simulador. */
export const ERRORS = {
  ESTRUCTURA: ['35', 'ARCHIVO NO CUMPLE ESTRUCTURA XML'],
  FIRMA: ['39', 'FIRMA INVALIDA'],
  CLAVE_REGISTRADA: ['43', 'CLAVE ACCESO REGISTRADA'],
  SECUENCIAL: ['45', 'SECUENCIAL REGISTRADO'],
  DIFERENCIAS: ['52', 'ERROR EN DIFERENCIAS'],
  EN_PROCESAMIENTO: ['70', 'CLAVE DE ACCESO EN PROCESAMIENTO'],
};

export function message([identificador, mensaje], informacionAdicional = null, tipo = 'ERROR') {
  return { identificador, mensaje, informacionAdicional, tipo };
}

const DS = 'http://www.w3.org/2000/09/xmldsig#';
const DIGESTS = { 'http://www.w3.org/2000/09/xmldsig#sha1': 'sha1', 'http://www.w3.org/2001/04/xmlenc#sha256': 'sha256' };
const SIGNATURES = { 'http://www.w3.org/2000/09/xmldsig#rsa-sha1': 'sha1', 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256': 'sha256' };
const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';

// ------------------------------------------------------------------ clave de acceso

export function mod11(digits) {
  let sum = 0;
  let factor = 2;
  for (let i = digits.length - 1; i >= 0; i--) {
    sum += Number(digits[i]) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const r = 11 - (sum % 11);
  return r === 11 ? 0 : r === 10 ? 1 : r;
}

export const isValidAccessKey = (k) => /^\d{49}$/.test(k) && mod11(k.slice(0, 48)) === Number(k[48]);

// ------------------------------------------------------------------ identificación

const province = (v) => {
  const p = Number(v.slice(0, 2));
  return (p >= 1 && p <= 24) || p === 30;
};

export function isValidCedula(v) {
  if (!/^\d{10}$/.test(v) || !province(v) || Number(v[2]) >= 6) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let p = Number(v[i]) * (i % 2 === 0 ? 2 : 1);
    if (p > 9) p -= 9;
    sum += p;
  }
  return (10 - (sum % 10)) % 10 === Number(v[9]);
}

export function isValidRuc(v) {
  if (!/^\d{13}$/.test(v) || v.slice(10) === '000' || !province(v)) return false;
  const third = Number(v[2]);
  return third < 6 ? isValidCedula(v.slice(0, 10)) : third === 6 || third === 9;
}

function buyerIdError(type, id) {
  switch (type) {
    case '04':
      return isValidRuc(id) ? null : 'RUC del comprador inválido';
    case '05':
      return isValidCedula(id) ? null : 'Cédula del comprador inválida';
    case '06':
    case '08':
      return /^[A-Za-z0-9]{3,20}$/.test(id) ? null : 'Pasaporte o identificación del exterior inválido';
    case '07':
      return id === '9999999999999' ? null : 'Consumidor final se identifica con 9999999999999';
    default:
      return `tipoIdentificacionComprador desconocido: ${type}`;
  }
}

// ------------------------------------------------------------------ estructura (recepción)

const DEC2 = /^\d{1,14}(\.\d{1,2})?$/;
const DEC6 = /^\d{1,14}(\.\d{1,6})?$/;
const FORMAS_PAGO = new Set(['01', '15', '16', '17', '18', '19', '20', '21']);

/** Comprobantes que acepta el simulador: raíz del XML → código, versiones y bloque de información. */
const DOC_KINDS = {
  factura: { codDoc: '01', label: 'factura', info: 'infoFactura', versions: ['1.0.0', '1.1.0', '2.0.0', '2.1.0'] },
  notaCredito: { codDoc: '04', label: 'nota de crédito', info: 'infoNotaCredito', versions: ['1.0.0', '1.1.0'] },
};

/**
 * Valida la factura o la nota de crédito contra la ficha técnica (campos obligatorios, formatos y longitudes), la
 * clave de acceso (dígito verificador y coherencia con los campos) y el comprador. Devuelve la
 * lista de problemas; vacía = RECIBIDA.
 */
export function structureErrors(root, opts = {}) {
  const errors = [];
  const need = (parent, name, re, label = name) => {
    const v = parent ? childText(parent, name) : null;
    if (v === null || v === '') errors.push(`Falta <${label}>`);
    else if (re && !(typeof re === 'function' ? re(v) : re.test(v))) errors.push(`<${label}> con formato inválido: "${v}"`);
    return v ?? '';
  };
  const optional = (parent, name, re) => {
    const v = childText(parent, name);
    if (v !== null && re && !re.test(v)) errors.push(`<${name}> con formato inválido: "${v}"`);
    return v;
  };
  const len = (min, max) => (v) => v.length >= min && v.length <= max;

  const kind = DOC_KINDS[root.local];
  if (!kind) return [`El elemento raíz debe ser <factura> o <notaCredito> (llegó <${root.name}>)`];
  const creditNote = root.local === 'notaCredito';
  const attr = (n) => root.attrs.find((a) => a.local === n)?.value;
  if (attr('id') !== 'comprobante') errors.push(`<${root.local}> debe tener id="comprobante"`);
  const version = attr('version');
  if (!kind.versions.includes(version)) errors.push(`Versión de ${kind.label} no soportada: ${version ?? '(sin version)'}`);
  const qty = version === '2.1.0' || version === '1.1.0' ? DEC6 : DEC2;

  const it = child(root, 'infoTributaria');
  const inf = child(root, kind.info);
  const det = child(root, 'detalles');
  if (!it) errors.push('Falta <infoTributaria>');
  if (!inf) errors.push(`Falta <${kind.info}>`);
  if (!det || childrenNamed(det, 'detalle').length === 0) errors.push(`La ${kind.label} debe tener al menos un <detalle>`);
  if (!it || !inf) return errors;

  const ambiente = need(it, 'ambiente', /^[12]$/);
  const tipoEmision = need(it, 'tipoEmision', /^1$/);
  need(it, 'razonSocial', len(1, 300));
  const ruc = need(it, 'ruc', isValidRuc);
  const clave = need(it, 'claveAcceso', /^\d{49}$/);
  const codDoc = need(it, 'codDoc', new RegExp(`^${kind.codDoc}$`));
  const estab = need(it, 'estab', /^\d{3}$/);
  const ptoEmi = need(it, 'ptoEmi', /^\d{3}$/);
  const secuencial = need(it, 'secuencial', /^\d{9}$/);
  need(it, 'dirMatriz', len(1, 300));

  const fecha = need(inf, 'fechaEmision', /^\d{2}\/\d{2}\/\d{4}$/);
  const [dd, mm, yyyy] = fecha.split('/');
  const date = new Date(`${yyyy}-${mm}-${dd}T12:00:00Z`);
  if (fecha && (Number.isNaN(date.getTime()) || date.getUTCDate() !== Number(dd))) errors.push(`Fecha de emisión inexistente: ${fecha}`);

  if (clave.length === 49) {
    if (!isValidAccessKey(clave)) errors.push('Clave de acceso con dígito verificador (módulo 11) incorrecto');
    const expected = `${dd}${mm}${yyyy}${codDoc}${ruc}${ambiente}${estab}${ptoEmi}${secuencial}`;
    if (clave.slice(0, 39) !== expected || clave[47] !== tipoEmision) {
      errors.push('La clave de acceso no coincide con fecha, tipo de comprobante, RUC, ambiente, serie, secuencial o tipo de emisión');
    }
  }

  optional(inf, 'obligadoContabilidad', /^(SI|NO)$/);
  const tipoId = need(inf, 'tipoIdentificacionComprador', /^0[4-8]$/);
  need(inf, 'razonSocialComprador', len(1, 300));
  const idComprador = need(inf, 'identificacionComprador', len(1, 20));
  if (tipoId && idComprador) {
    const e = buyerIdError(tipoId, idComprador);
    if (e) errors.push(e);
  }
  need(inf, 'totalSinImpuestos', DEC2);
  if (creditNote) {
    if (tipoId === '07') errors.push('Una nota de crédito no puede emitirse a consumidor final');
    need(inf, 'codDocModificado', /^0[1-7]$/);
    need(inf, 'numDocModificado', /^\d{3}-\d{3}-\d{9}$/);
    const sustento = need(inf, 'fechaEmisionDocSustento', /^\d{2}\/\d{2}\/\d{4}$/);
    const [sd, sm, sy] = sustento.split('/');
    if (sustento && new Date(`${sy}-${sm}-${sd}T12:00:00Z`) > date) errors.push('La fecha del documento modificado es posterior a la de la nota de crédito');
    need(inf, 'valorModificacion', DEC2);
    need(inf, 'motivo', len(1, 300));
  } else {
    need(inf, 'totalDescuento', DEC2);
    const importeTotal = need(inf, 'importeTotal', DEC2);
    optional(inf, 'propina', DEC2);
    if (tipoId === '07' && opts.consumerFinalMax > 0 && Number(importeTotal) > opts.consumerFinalMax) {
      errors.push(`Una factura a consumidor final no puede superar USD ${opts.consumerFinalMax.toFixed(2)} (importeTotal ${importeTotal})`);
    }
  }

  const tci = child(inf, 'totalConImpuestos');
  const totals = tci ? childrenNamed(tci, 'totalImpuesto') : [];
  if (!totals.length) errors.push('Falta <totalConImpuestos> con al menos un <totalImpuesto>');
  for (const t of totals) {
    need(t, 'codigo', /^[235]$/, 'totalImpuesto/codigo');
    need(t, 'codigoPorcentaje', /^\d{1,4}$/, 'totalImpuesto/codigoPorcentaje');
    need(t, 'baseImponible', DEC2, 'totalImpuesto/baseImponible');
    need(t, 'valor', DEC2, 'totalImpuesto/valor');
  }
  if (!creditNote) {
    const pagos = child(inf, 'pagos');
    const pagoList = pagos ? childrenNamed(pagos, 'pago') : [];
    if (!pagoList.length) errors.push('Falta <pagos> con al menos un <pago>');
    for (const p of pagoList) {
      need(p, 'formaPago', (v) => FORMAS_PAGO.has(v), 'pago/formaPago');
      need(p, 'total', DEC2, 'pago/total');
    }
  }

  const codeTag = creditNote ? 'codigoInterno' : 'codigoPrincipal';
  for (const d of det ? childrenNamed(det, 'detalle') : []) {
    need(d, codeTag, len(1, 25), `detalle/${codeTag}`);
    need(d, 'descripcion', len(1, 300), 'detalle/descripcion');
    need(d, 'cantidad', qty, 'detalle/cantidad');
    need(d, 'precioUnitario', qty, 'detalle/precioUnitario');
    need(d, 'descuento', DEC2, 'detalle/descuento');
    need(d, 'precioTotalSinImpuesto', DEC2, 'detalle/precioTotalSinImpuesto');
    const imp = child(d, 'impuestos');
    const list = imp ? childrenNamed(imp, 'impuesto') : [];
    if (!list.length) errors.push('Cada <detalle> debe tener <impuestos> con al menos un <impuesto>');
    for (const i of list) {
      need(i, 'codigo', /^[235]$/, 'impuesto/codigo');
      need(i, 'codigoPorcentaje', /^\d{1,4}$/, 'impuesto/codigoPorcentaje');
      need(i, 'tarifa', /^\d{1,4}(\.\d{1,2})?$/, 'impuesto/tarifa');
      need(i, 'baseImponible', DEC2, 'impuesto/baseImponible');
      need(i, 'valor', DEC2, 'impuesto/valor');
    }
  }
  return errors;
}

/**
 * Datos para indexar el comprobante (secuencial registrado, ambiente) y, según el tipo, el total de
 * la factura o el documento que modifica la nota de crédito (serie ruc-codDoc-estab-ptoEmi-secuencial).
 */
export function identity(root) {
  const it = child(root, 'infoTributaria');
  const ruc = childText(it, 'ruc');
  const base = {
    claveAcceso: childText(it, 'claveAcceso'),
    ambiente: childText(it, 'ambiente'),
    serie: `${ruc}-${childText(it, 'codDoc')}-${childText(it, 'estab')}-${childText(it, 'ptoEmi')}-${childText(it, 'secuencial')}`,
  };
  if (root.local === 'notaCredito') {
    const inf = child(root, 'infoNotaCredito');
    const [estab, pto, sec] = (childText(inf, 'numDocModificado') ?? '').split('-');
    return { ...base, modifica: `${ruc}-${childText(inf, 'codDocModificado')}-${estab}-${pto}-${sec}`, valor: cents(childText(inf, 'valorModificacion')) };
  }
  return { ...base, total: cents(childText(child(root, 'infoFactura'), 'importeTotal')) };
}

// ------------------------------------------------------------------ totales (autorización)

const cents = (v) => Math.round(Number(v ?? 0) * 100);
const near = (a, b) => Math.abs(a - b) <= 1; // tolerancia de 1 centavo, como el SRI

/**
 * Cuadre de montos: líneas, IVA, totales por impuesto y total (importeTotal y pagos en la factura;
 * valorModificacion en la nota de crédito, que no lleva descuento total, propina ni pagos).
 */
export function totalErrors(root) {
  const errors = [];
  const creditNote = root.local === 'notaCredito';
  const inf = child(root, creditNote ? 'infoNotaCredito' : 'infoFactura');
  const detalles = childrenNamed(child(root, 'detalles'), 'detalle');
  let sinImpuestos = 0;
  let descuentos = 0;
  const porImpuesto = new Map();
  detalles.forEach((d, n) => {
    const qty = Number(childText(d, 'cantidad'));
    const price = Number(childText(d, 'precioUnitario'));
    const desc = cents(childText(d, 'descuento'));
    const total = cents(childText(d, 'precioTotalSinImpuesto'));
    if (!near(Math.round(qty * price * 100) - desc, total)) errors.push(`Detalle ${n + 1}: cantidad × precioUnitario − descuento ≠ precioTotalSinImpuesto`);
    sinImpuestos += total;
    descuentos += desc;
    for (const i of childrenNamed(child(d, 'impuestos'), 'impuesto')) {
      const base = cents(childText(i, 'baseImponible'));
      const valor = cents(childText(i, 'valor'));
      const tarifa = Number(childText(i, 'tarifa'));
      if (!near(Math.round((base * tarifa) / 100), valor)) errors.push(`Detalle ${n + 1}: el IVA no corresponde a la base y la tarifa`);
      if (!near(base, total)) errors.push(`Detalle ${n + 1}: baseImponible ≠ precioTotalSinImpuesto`);
      const key = `${childText(i, 'codigo')}/${childText(i, 'codigoPorcentaje')}`;
      const g = porImpuesto.get(key) ?? { base: 0, valor: 0 };
      g.base += base;
      g.valor += valor;
      porImpuesto.set(key, g);
    }
  });
  if (!near(cents(childText(inf, 'totalSinImpuestos')), sinImpuestos)) errors.push('totalSinImpuestos ≠ suma de precioTotalSinImpuesto');
  if (!creditNote && !near(cents(childText(inf, 'totalDescuento')), descuentos)) errors.push('totalDescuento ≠ suma de descuentos');
  let impuestos = 0;
  const declared = new Set();
  for (const t of childrenNamed(child(inf, 'totalConImpuestos'), 'totalImpuesto')) {
    const key = `${childText(t, 'codigo')}/${childText(t, 'codigoPorcentaje')}`;
    declared.add(key);
    const g = porImpuesto.get(key) ?? { base: 0, valor: 0 };
    if (!near(cents(childText(t, 'baseImponible')), g.base) || !near(cents(childText(t, 'valor')), g.valor)) {
      errors.push(`totalImpuesto ${key} no cuadra con los detalles`);
    }
    impuestos += cents(childText(t, 'valor'));
  }
  for (const key of porImpuesto.keys()) if (!declared.has(key)) errors.push(`Falta totalImpuesto para ${key}`);
  if (creditNote) {
    if (!near(sinImpuestos + impuestos, cents(childText(inf, 'valorModificacion')))) errors.push('valorModificacion ≠ totalSinImpuestos + impuestos');
    return errors;
  }
  const importe = cents(childText(inf, 'importeTotal'));
  if (!near(sinImpuestos + impuestos + cents(childText(inf, 'propina')), importe)) errors.push('importeTotal ≠ totalSinImpuestos + impuestos + propina');
  const pagos = childrenNamed(child(inf, 'pagos'), 'pago').reduce((s, p) => s + cents(childText(p, 'total')), 0);
  if (!near(pagos, importe)) errors.push('La suma de <pagos> no es igual al importeTotal');
  return errors;
}

// ------------------------------------------------------------------ firma XAdES-BES

const digest = (alg, data) => createHash(alg).update(data, 'utf8').digest('base64');

/**
 * Verifica la firma enveloped del comprobante: cada Reference (digest de la parte canonicalizada,
 * con la transformación enveloped-signature cuando corresponde), que una de ellas cubra
 * #comprobante, el SignatureValue sobre SignedInfo canónico con la clave del certificado, y la
 * vigencia del certificado. Un certificado autofirmado se acepta (es un simulador).
 */
export function signatureErrors(root, now = new Date()) {
  const signature = elements(root).find((e) => e.local === 'Signature' && e.ns === DS);
  if (!signature) return ['El comprobante no está firmado (falta ds:Signature)'];
  const signedInfo = child(signature, 'SignedInfo');
  const valueText = childText(signature, 'SignatureValue');
  const certText = [...walk(signature)].find((n) => n.local === 'X509Certificate' && n.ns === DS);
  if (!signedInfo || !valueText || !certText) return ['Firma incompleta: faltan SignedInfo, SignatureValue o X509Certificate'];

  const errors = [];
  const c14n = child(signedInfo, 'CanonicalizationMethod')?.attrs.find((a) => a.local === 'Algorithm')?.value;
  if (c14n !== C14N) errors.push(`CanonicalizationMethod no soportado: ${c14n}`);
  const sigAlg = SIGNATURES[child(signedInfo, 'SignatureMethod')?.attrs.find((a) => a.local === 'Algorithm')?.value];
  if (!sigAlg) errors.push('SignatureMethod no soportado');

  let coversComprobante = false;
  for (const ref of childrenNamed(signedInfo, 'Reference')) {
    const uri = ref.attrs.find((a) => a.local === 'URI')?.value ?? '';
    const target = uri.startsWith('#') ? findById(root, uri.slice(1)) : null;
    if (!target) {
      errors.push(`Reference a un elemento inexistente: ${uri}`);
      continue;
    }
    const transforms = childrenNamed(child(ref, 'Transforms') ?? { children: [] }, 'Transform').map(
      (t) => t.attrs.find((a) => a.local === 'Algorithm')?.value,
    );
    const alg = DIGESTS[child(ref, 'DigestMethod')?.attrs.find((a) => a.local === 'Algorithm')?.value];
    if (!alg) {
      errors.push(`DigestMethod no soportado en ${uri}`);
      continue;
    }
    const enveloped = transforms.includes(ENVELOPED);
    const actual = digest(alg, canonicalize(target, enveloped ? signature : null));
    if (actual !== childText(ref, 'DigestValue')) errors.push(`El digest de ${uri} no coincide: el contenido firmado fue modificado`);
    if (target === root && enveloped) coversComprobante = true;
  }
  if (!coversComprobante) errors.push('Ninguna Reference firma el comprobante (#comprobante con enveloped-signature)');

  let cert;
  try {
    cert = new X509Certificate(Buffer.from(textOf(certText).replace(/\s+/g, ''), 'base64'));
  } catch {
    return [...errors, 'X509Certificate ilegible'];
  }
  if (new Date(cert.validFrom) > now || new Date(cert.validTo) < now) errors.push(`Certificado fuera de vigencia (${cert.validFrom} - ${cert.validTo})`);
  if (sigAlg) {
    const ok = verifySignatureValue(sigAlg, Buffer.from(canonicalize(signedInfo), 'utf8'), cert.publicKey, Buffer.from(valueText.replace(/\s+/g, ''), 'base64'));
    if (!ok) errors.push('SignatureValue no corresponde a SignedInfo con la clave del certificado');
  }
  return errors;
}
