'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { api, errorMessage, isApiError } from '@/lib/api/client';
import type { Tracking } from '@/lib/commerce-types';
import { REALTIME_PATH, REALTIME_URL } from '@/lib/config';
import { formatDate, formatEta, formatSlot, formatTime } from '@/lib/format';
import { LIVE_STATUSES, type Point, SHIPMENT_STEPS, showDeliveryCode, stepOf } from '@/lib/tracking';
import { TrackingMap } from './TrackingMap';

interface LivePosition extends Point {
  heading: number | null;
  speedKmh: number | null;
  recordedAt: string;
  etaSeconds: number | null;
}

const POLL_MS = 30_000;
const VEHICLE: Record<string, string> = { motorcycle: 'Moto', bicycle: 'Bicicleta', car: 'Auto', van: 'Furgoneta' };

/**
 * Seguimiento en vivo. Carga el estado por HTTP y se suscribe por Socket.IO (apps/realtime) a la
 * sala del pedido: `rider.location` mueve al motorizado y `shipment.status` refresca la línea de
 * tiempo. Si el socket se cae, consulta por HTTP cada 30 s hasta que vuelva.
 */
export function TrackingView({ token }: { token: string }) {
  const [data, setData] = useState<Tracking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<LivePosition | null>(null);
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [etaBase, setEtaBase] = useState<{ at: number; seconds: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const view = await api<Tracking>(`/tracking/${encodeURIComponent(token)}`);
      setData(view);
      if (view.riderPosition && LIVE_STATUSES.has(view.status)) {
        setPosition((p) => p ?? { ...view.riderPosition!, etaSeconds: view.eta ? Math.max(0, (new Date(view.eta).getTime() - Date.now()) / 1000) : null });
      }
      if (!LIVE_STATUSES.has(view.status)) setPosition(null);
    } catch (e) {
      setError(isApiError(e) && (e.status === 404 || e.status === 400) ? 'Este enlace de seguimiento no existe o expiró.' : errorMessage(e));
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  // Socket.IO: solo websocket (el handshake lleva el token; no hace falta CORS).
  useEffect(() => {
    let socket: Socket | null = null;
    let cancelled = false;
    void import('socket.io-client').then(({ io }) => {
      if (cancelled) return;
      socket = io(REALTIME_URL ?? '', { path: REALTIME_PATH, transports: ['websocket'], auth: { trackingToken: token }, reconnectionDelayMax: 10_000 });
      socket.on('tracking.ready', () => setConnected(true));
      socket.on('disconnect', () => setConnected(false));
      socket.on('connect_error', () => setConnected(false));
      socket.on('tracking.error', () => setConnected(false));
      socket.on('rider.location', (p: LivePosition) => {
        setPosition(p);
        if (p.etaSeconds !== null) setEtaBase({ at: Date.now(), seconds: p.etaSeconds });
      });
      socket.on('shipment.status', () => void load());
    });
    return () => {
      cancelled = true;
      socket?.disconnect();
    };
  }, [token, load]);

  // Respaldo sin socket y reloj para la cuenta regresiva del ETA.
  useEffect(() => {
    const poll = connected ? null : setInterval(() => void load(), POLL_MS);
    const clock = setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      if (poll) clearInterval(poll);
      clearInterval(clock);
    };
  }, [connected, load]);

  if (error) {
    return (
      <div className="container-page py-20 text-center">
        <h1 className="text-3xl">Seguimiento no disponible</h1>
        <p className="mt-3 text-ink-soft">{error}</p>
      </div>
    );
  }
  if (!data) return <div className="container-page py-16 text-ink-soft">Cargando seguimiento…</div>;

  const live = LIVE_STATUSES.has(data.status);
  const step = stepOf(data.status);
  const eta = etaBase ? Math.max(0, etaBase.seconds - (now - etaBase.at) / 1000) : data.eta ? Math.max(0, (new Date(data.eta).getTime() - now) / 1000) : null;
  const headline =
    data.status === 'delivered'
      ? 'Tu pedido fue entregado'
      : data.status === 'arriving'
        ? '¡El motorizado está llegando!'
        : live
          ? 'Tu pedido está en camino'
          : data.status === 'assigned' || data.status === 'accepted'
            ? 'Asignamos un motorizado a tu pedido'
            : data.status === 'failed_attempt'
              ? 'No pudimos entregar tu pedido: el motorizado lo reintentará'
              : data.status === 'cancelled'
                ? 'El envío fue cancelado'
                : 'Estamos preparando tu pedido';

  return (
    <div className="container-page grid gap-8 py-8 lg:grid-cols-[1fr_380px]">
      <div className="order-2 lg:order-1">
        <TrackingMap destination={data.destination.location} origin={data.origin?.location ?? null} rider={live ? position : null} />
        <p className="mt-2 flex items-center gap-2 text-xs text-ink-soft" aria-live="polite">
          <span className={`h-2 w-2 rounded-full ${connected ? 'bg-ok' : 'bg-line'}`} aria-hidden />
          {connected ? 'En vivo' : 'Reconectando… (actualizamos cada 30 s)'}
          {position && live && ` · última posición ${formatTime(position.recordedAt)}`}
        </p>
      </div>
      <aside className="order-1 space-y-5 lg:order-2">
        <div>
          {data.orderNumber && <p className="text-sm text-ink-soft">Pedido #{data.orderNumber}</p>}
          <h1 className="text-3xl">{headline}</h1>
          {live && eta !== null && (
            <p className="mt-2 text-lg">
              Llega en <strong>~{formatEta(eta)}</strong>
            </p>
          )}
          {!live && data.slot && data.status !== 'delivered' && <p className="mt-2 text-sm text-ink-soft">Franja de entrega: {formatSlot(data.slot.startsAt, data.slot.endsAt)}</p>}
          {data.deliveredAt && <p className="mt-2 text-sm text-ink-soft">{formatDate(data.deliveredAt, { dateStyle: 'medium', timeStyle: 'short' })}</p>}
          <p className="mt-2 text-sm text-ink-soft">Entrega en {data.destination.label}</p>
        </div>

        {showDeliveryCode(data) && (
          <div className="card p-4" role="status">
            <p className="text-sm text-ink-soft">Código de entrega</p>
            <p className="mt-1 font-mono text-4xl font-semibold tracking-[0.4em]">{data.deliveryCode}</p>
            <p className="mt-2 text-sm text-ink-soft">Díselo al motorizado al recibir tu pedido. No lo compartas antes.</p>
          </div>
        )}

        {data.rider && data.status !== 'delivered' && (
          <div className="card flex items-center gap-3 p-4">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-sand text-xl" aria-hidden>
              🛵
            </span>
            <div className="text-sm">
              <p className="font-medium">Tu motorizado</p>
              <p className="text-ink-soft">
                {VEHICLE[data.rider.vehicleType] ?? data.rider.vehicleType}
                {data.rider.plate && ` · ${data.rider.plate}`} · ★ {data.rider.ratingAvg}
              </p>
            </div>
          </div>
        )}

        {data.status !== 'cancelled' && (
          <ol className="space-y-3" aria-label="Estado del envío">
            {SHIPMENT_STEPS.map((s, i) => {
              const event = [...data.events].reverse().find((e) => e.status === s.status);
              return (
                <li key={s.status} className="flex gap-3" aria-current={i === step ? 'step' : undefined}>
                  <span className={`mt-1 h-3 w-3 shrink-0 rounded-full ${i < step ? 'bg-accent' : i === step ? 'bg-accent ring-4 ring-accent/20' : 'bg-line'}`} aria-hidden />
                  <span className="text-sm">
                    <span className={i <= step ? 'font-medium' : 'text-ink-soft'}>{s.label}</span>
                    {event && <span className="block text-xs text-ink-soft">{formatDate(event.occurredAt, { dateStyle: 'short', timeStyle: 'short' })}</span>}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
        <p className="text-xs text-ink-soft">Activa los avisos en Mi cuenta para que te notifiquemos aunque cierres esta página.</p>
      </aside>
    </div>
  );
}
