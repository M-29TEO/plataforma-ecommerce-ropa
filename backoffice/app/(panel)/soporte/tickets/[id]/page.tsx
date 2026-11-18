'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { Composer } from '@/components/soporte/Composer';
import { Conversation } from '@/components/soporte/Conversation';
import { useAgents, useNow } from '@/components/soporte/hooks';
import { LinkedOrder } from '@/components/soporte/LinkedOrder';
import { SlaBadge } from '@/components/soporte/SlaBadge';
import { TicketAssignee, TicketFields } from '@/components/soporte/TicketManage';
import { ticketKey } from '@/components/soporte/useTicketAction';
import { useCan } from '@/components/providers/AuthProvider';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryState } from '@/components/ui/States';
import { api } from '@/lib/api/client';
import { formatDateTime } from '@/lib/format';
import { CATEGORY_LABELS, CHANNEL_LABELS, CSAT_LABELS, PRIORITY_MAP, STATUS_MAP, type TicketDetail } from '@/lib/support';

/** Ficha del ticket: conversación con notas internas, respuesta, gestión, asignación, pedido y CSAT. */
export default function TicketDetailPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const now = useNow();
  const agents = useAgents();
  const q = useQuery({
    queryKey: ticketKey(id),
    queryFn: ({ signal }) => api<TicketDetail>(`/support/tickets/${id}`, { signal }),
    // Mensajes nuevos del cliente sin recargar la página.
    refetchInterval: 30_000,
  });
  const canWrite = can('support.tickets.write');

  return (
    <QueryState query={q} loading="Cargando el ticket…">
      {(t) => {
        const contact = t.requesterContact;
        const customerName = contact?.name || contact?.email || (t.requesterId ? 'Cliente registrado' : 'Cliente');
        return (
          <div>
            <PageHeader
              back={{ href: '/soporte/tickets', label: 'Tickets' }}
              title={
                <>
                  <span className="text-ink-soft tabular-nums">#{t.number}</span> {t.subject}
                </>
              }
              description={
                <span className="mt-1 flex flex-wrap items-center gap-1.5">
                  <StatusBadge status={t.status} map={STATUS_MAP} />
                  <StatusBadge status={t.priority} map={PRIORITY_MAP} />
                  <Badge>{CATEGORY_LABELS[t.category] ?? t.category}</Badge>
                  <Badge>Canal: {CHANNEL_LABELS[t.channel] ?? t.channel}</Badge>
                  <SlaBadge ticket={t} now={now} />
                </span>
              }
            />

            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
              <div className="min-w-0 space-y-4">
                <section className="card p-4">
                  <Conversation ticket={t} agentName={agents.name} customerName={customerName} />
                </section>
                {canWrite && <Composer key={t.id} ticket={t} />}
              </div>

              <aside className="space-y-4">
                {canWrite && (
                  <Panel title="Gestión">
                    {/* key con la versión: tras un cambio (propio o de otro agente) el formulario parte del estado real. */}
                    <TicketFields key={t.version} ticket={t} />
                  </Panel>
                )}
                <Panel title="Asignación">
                  <TicketAssignee ticket={t} agents={agents} />
                </Panel>
                <Panel title="Cliente">
                  <dl className="space-y-1.5 text-sm">
                    <Row label="Nombre">{contact?.name || (t.requesterId ? 'Cliente registrado' : '—')}</Row>
                    {contact?.email && <Row label="Email">{contact.email}</Row>}
                    {contact?.phone && <Row label="Teléfono">{contact.phone}</Row>}
                    {!t.requesterId && !contact?.email && <p className="text-xs text-ink-soft">Ticket interno: sin cliente, solo admite notas.</p>}
                  </dl>
                </Panel>
                {t.orderId && (
                  <Panel title="Pedido vinculado">
                    <LinkedOrder orderId={t.orderId} shipmentId={t.shipmentId} />
                  </Panel>
                )}
                <Panel title="Fechas">
                  <dl className="space-y-1.5 text-sm">
                    <Row label="Creado">{formatDateTime(t.createdAt)}</Row>
                    <Row label="Vence el SLA">{formatDateTime(t.slaDueAt)}</Row>
                    {t.slaBreachedAt && <Row label="Alerta de SLA">{formatDateTime(t.slaBreachedAt)}</Row>}
                    <Row label="Primera respuesta">{formatDateTime(t.firstResponseAt)}</Row>
                    {t.resolvedAt && <Row label="Resuelto">{formatDateTime(t.resolvedAt)}</Row>}
                    {t.closedAt && <Row label="Cerrado">{formatDateTime(t.closedAt)}</Row>}
                  </dl>
                </Panel>
                {(t.csat !== null || t.status === 'closed') && (
                  <Panel title="Satisfacción (CSAT)">
                    {t.csat !== null ? (
                      <div className="text-sm">
                        <p>
                          <span className="text-lg font-semibold tabular-nums">{t.csat}</span>
                          <span className="text-ink-soft"> / 5 · {CSAT_LABELS[t.csat]}</span>
                        </p>
                        {t.csatComment && <blockquote className="mt-2 border-l-2 border-line pl-3 whitespace-pre-wrap text-ink-soft">{t.csatComment}</blockquote>}
                        {t.csatAt && <p className="mt-1 text-[11px] text-ink-soft">{formatDateTime(t.csatAt)}</p>}
                      </div>
                    ) : (
                      <p className="text-sm text-ink-soft">Encuesta enviada; el cliente aún no responde.</p>
                    )}
                  </Panel>
                )}
              </aside>
            </div>
          </div>
        );
      }}
    </QueryState>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card p-4">
      <h2 className="mb-3 text-xs font-semibold tracking-wide text-ink-soft uppercase">{title}</h2>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-soft">{label}</dt>
      <dd className="text-right break-all">{children}</dd>
    </div>
  );
}
