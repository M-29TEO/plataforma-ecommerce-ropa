import { describe, expect, it } from 'vitest';
import {
  buildInspectBody,
  buildRegisterBody,
  canRegisterReturn,
  creditNoteFor,
  emptyDraft,
  type ElectronicDocument,
  type Refund,
  refundApproval,
  RETURN_STATUS,
  RETURN_STATUSES,
  returnableQuantities,
  returnActions,
  returnsQuery,
  type ReturnDraft,
  validateDraft,
  withCondition,
} from './returns';

const ALL = ['returns.read', 'returns.approve', 'returns.inspect', 'payments.refund.approve'];

describe('etiquetas', () => {
  it('cada estado del dominio tiene etiqueta en español', () => {
    for (const s of RETURN_STATUSES) expect(RETURN_STATUS[s][0]).toBeTruthy();
    expect(RETURN_STATUS.pickup_scheduled[0]).toBe('Retiro programado');
  });
});

describe('acciones según estado y permisos', () => {
  it('solicitada: aprobar o rechazar con returns.approve', () => {
    expect(returnActions({ status: 'requested', type: 'return' }, ALL)).toEqual({ approve: true, reject: true, receive: false, inspect: false, retryExchange: false });
    // Bodega (solo inspect) no aprueba.
    expect(returnActions({ status: 'requested', type: 'return' }, ['returns.read', 'returns.inspect'])).toMatchObject({ approve: false, reject: false });
  });

  it('aprobada o con retiro: bodega la recibe', () => {
    expect(returnActions({ status: 'pickup_scheduled', type: 'return' }, ['returns.inspect']).receive).toBe(true);
    expect(returnActions({ status: 'approved', type: 'return' }, ['returns.inspect']).receive).toBe(true);
    expect(returnActions({ status: 'approved', type: 'return' }, ['returns.approve']).receive).toBe(false);
  });

  it('recibida: inspeccionar (bodega) o rechazar (soporte)', () => {
    expect(returnActions({ status: 'received', type: 'return' }, ALL)).toMatchObject({ inspect: true, reject: true, approve: false });
  });

  it('cambio inspeccionado sin envío: reintentar; estados finales sin acciones', () => {
    expect(returnActions({ status: 'inspected', type: 'exchange' }, ALL).retryExchange).toBe(true);
    expect(returnActions({ status: 'inspected', type: 'return' }, ALL).retryExchange).toBe(false);
    for (const s of ['refunded', 'exchanged', 'rejected', 'closed'] as const) {
      expect(Object.values(returnActions({ status: s, type: 'return' }, ALL)).some(Boolean)).toBe(false);
    }
  });
});

describe('aprobación del reembolso', () => {
  const refund = (over: Partial<Refund> = {}): Refund => ({
    id: 'r1',
    paymentId: 'p1',
    orderId: 'o1',
    returnId: 'ret1',
    amount: '150.00',
    method: 'original',
    status: 'pending',
    providerRef: null,
    reason: null,
    requestedBy: 'bodega',
    approvedBy: null,
    createdAt: '2026-10-07T12:00:00Z',
    completedAt: null,
    approvals: [],
    plan: null,
    completedParts: [],
    failureReason: null,
    paymentMethod: 'card',
    requiredApprovals: 2,
    pendingParts: [],
    ...over,
  });

  it('por encima del umbral hacen falta dos personas distintas', () => {
    expect(refundApproval(refund(), 'gerente', ALL)).toMatchObject({ canApprove: true, done: 0, required: 2 });
    const first = refund({ approvals: [{ userId: 'gerente', at: '2026-10-07T13:00:00Z' }] });
    expect(refundApproval(first, 'gerente', ALL)).toMatchObject({ canApprove: false, done: 1 });
    expect(refundApproval(first, 'gerente', ALL).blockedReason).toMatch(/otra persona/);
    expect(refundApproval(first, 'admin', ALL).canApprove).toBe(true);
  });

  it('nunca aprueba quien lo solicitó ni quien no tiene el permiso', () => {
    expect(refundApproval(refund(), 'bodega', ALL).canApprove).toBe(false);
    expect(refundApproval(refund(), 'soporte', ['returns.read']).blockedReason).toMatch(/rol/);
  });

  it('un reembolso que ya no está pendiente no se aprueba ni muestra aviso', () => {
    expect(refundApproval(refund({ status: 'succeeded' }), 'gerente', ALL)).toMatchObject({ canApprove: false, blockedReason: null });
  });
});

describe('cola', () => {
  it('abiertas = todo lo que aún requiere trabajo; filtro por pedido', () => {
    expect(returnsQuery('active', 25, 0).status).toEqual(['requested', 'approved', 'pickup_scheduled', 'received', 'inspected']);
    expect(returnsQuery('', 25, 50)).toMatchObject({ status: undefined, limit: 25, offset: 50 });
    expect(returnsQuery('rejected', 10, 0, 'o1')).toMatchObject({ status: ['rejected'], orderId: 'o1' });
  });
});

describe('registro por soporte', () => {
  it('solo pedidos entregados (o parcialmente devueltos) y con returns.approve', () => {
    expect(canRegisterReturn({ status: 'delivered' }, ALL)).toBe(true);
    expect(canRegisterReturn({ status: 'partially_returned' }, ALL)).toBe(true);
    expect(canRegisterReturn({ status: 'in_transit' }, ALL)).toBe(false);
    expect(canRegisterReturn({ status: 'delivered' }, ['returns.read'])).toBe(false);
  });

  it('devolvible = comprado − devuelto − en solicitudes abiertas', () => {
    const items = [
      { id: 'a', quantity: 3, qtyReturned: 1 },
      { id: 'b', quantity: 1, qtyReturned: 0 },
    ];
    const returns = [
      { status: 'requested' as const, items: [{ id: 'x', orderItemId: 'a', quantity: 1, reasonCode: 'other' as const, condition: null, restock: null, exchangeVariantId: null, photos: [] }] },
      // Rechazada: sus unidades vuelven a estar disponibles.
      { status: 'rejected' as const, items: [{ id: 'y', orderItemId: 'b', quantity: 1, reasonCode: 'other' as const, condition: null, restock: null, exchangeVariantId: null, photos: [] }] },
    ];
    const av = returnableQuantities(items, returns);
    expect(av.get('a')).toBe(1);
    expect(av.get('b')).toBe(1);
  });

  const draft = (over: Partial<ReturnDraft> = {}): ReturnDraft => ({
    ...emptyDraft(),
    lines: { a: { quantity: 1, reasonCode: 'size_small', exchangeVariantId: '' }, b: { quantity: 0, reasonCode: '', exchangeVariantId: '' } },
    ...over,
  });

  it('arma el cuerpo: sin líneas en 0, resolución solo en devoluciones, textos recortados', () => {
    expect(buildRegisterBody('o1', draft({ resolution: 'store_credit', reason: '  Llamó a soporte ', customerNotes: ' ' }))).toEqual({
      orderId: 'o1',
      type: 'return',
      resolution: 'store_credit',
      reason: 'Llamó a soporte',
      items: [{ orderItemId: 'a', quantity: 1, reasonCode: 'size_small' }],
    });
    const ex = buildRegisterBody('o1', draft({ type: 'exchange', lines: { a: { quantity: 1, reasonCode: 'size_small', exchangeVariantId: 'v2' } } }));
    expect(ex).toEqual({ orderId: 'o1', type: 'exchange', items: [{ orderItemId: 'a', quantity: 1, reasonCode: 'size_small', exchangeVariantId: 'v2' }] });
  });

  it('valida cantidades, motivos y talla del cambio; avisa de los motivos que exigen foto', () => {
    const av = new Map([
      ['a', 1],
      ['b', 1],
    ]);
    expect(validateDraft(draft(), av)).toEqual({ errors: [], warnings: [] });
    expect(validateDraft(draft({ lines: {} }), av).errors[0]).toMatch(/al menos un producto/);
    expect(validateDraft(draft({ lines: { a: { quantity: 2, reasonCode: 'other', exchangeVariantId: '' } } }), av).errors[0]).toMatch(/máx\. 1/);
    expect(validateDraft(draft({ lines: { a: { quantity: 1, reasonCode: '', exchangeVariantId: '' } } }), av).errors[0]).toMatch(/motivo/);
    expect(validateDraft(draft({ type: 'exchange' }), av).errors[0]).toMatch(/talla nueva/);
    expect(validateDraft(draft({ lines: { a: { quantity: 1, reasonCode: 'defect', exchangeVariantId: '' } } }), av).warnings[0]).toMatch(/fotos/);
  });
});

describe('inspección', () => {
  it('dañado no vuelve al stock; nuevo sí', () => {
    expect(withCondition({ condition: 'new', restock: true }, 'damaged')).toEqual({ condition: 'damaged', restock: false });
    expect(withCondition({ condition: 'damaged', restock: false }, 'new')).toEqual({ condition: 'new', restock: true });
    expect(withCondition({ condition: 'new', restock: false }, 'used').restock).toBe(false);
  });

  it('el cuerpo cubre todas las líneas y nunca reingresa un dañado', () => {
    const lines = [{ returnItemId: 'l1' }, { returnItemId: 'l2' }];
    expect(buildInspectBody(lines, { l1: { condition: 'damaged', restock: true } })).toEqual({
      items: [
        { returnItemId: 'l1', condition: 'damaged', restock: false },
        { returnItemId: 'l2', condition: 'new', restock: true },
      ],
    });
  });
});

describe('nota de crédito', () => {
  const doc = (over: Partial<ElectronicDocument>): ElectronicDocument => ({
    id: 'd',
    docType: '04',
    number: '001-001-000000001',
    accessKey: 'k',
    issueDate: '2026-10-07',
    orderId: 'o1',
    returnId: 'ret1',
    status: 'authorized',
    totals: { total: '23.00' },
    authorizationNumber: null,
    authorizedAt: null,
    files: { xml: true, ride: true },
    createdAt: '2026-10-07T12:00:00Z',
    ...over,
  });

  it('elige la nota de crédito (04) de esa devolución, la más reciente', () => {
    const docs = [doc({ id: 'f', docType: '01', returnId: null }), doc({ id: 'old' }), doc({ id: 'new', createdAt: '2026-10-08T12:00:00Z' }), doc({ id: 'otra', returnId: 'ret2' })];
    expect(creditNoteFor(docs, 'ret1')?.id).toBe('new');
    expect(creditNoteFor(docs, 'ret9')).toBeNull();
  });
});
