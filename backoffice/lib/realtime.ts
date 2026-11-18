'use client';

import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { getAccessToken, onAccessTokenChange, refreshSession } from './api/client';
import { REALTIME_PATH, REALTIME_URL } from './config';
import type { StaffEvent } from './logistics';

/**
 * Socket del staff (namespace /staff de Socket.IO): posiciones, presencia de motorizados y
 * cambios de estado de envíos en vivo. El servidor no reenvía lo perdido mientras el socket
 * estuvo caído: al volver a conectar se llama `onResync` para recargar por HTTP.
 */
export type StaffConnection = 'connecting' | 'live' | 'reconnecting' | 'forbidden';

export const CONNECTION_LABEL: Record<StaffConnection, string> = {
  connecting: 'Conectando…',
  live: 'En vivo',
  reconnecting: 'Reconectando',
  forbidden: 'Sin acceso al tiempo real',
};

export function useStaffSocket({ onEvent, onResync, enabled = true }: { onEvent: (e: StaffEvent) => void; onResync: () => void; enabled?: boolean }): StaffConnection {
  const [state, setState] = useState<StaffConnection>('connecting');
  const handlers = useRef({ onEvent, onResync });
  useEffect(() => {
    handlers.current = { onEvent, onResync };
  });

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let readyOnce = false;
    let triedUnauthorized = false;
    const socket: Socket = io(`${REALTIME_URL ?? ''}/staff`, {
      path: REALTIME_PATH,
      auth: { accessToken: getAccessToken() },
      autoConnect: false,
      transports: ['websocket', 'polling'],
    });

    const reconnectWith = (token: string | null) => {
      if (disposed || !token) return;
      socket.auth = { accessToken: token };
      if (socket.active) socket.disconnect();
      socket.connect();
    };

    socket.on('staff.ready', () => {
      setState('live');
      triedUnauthorized = false;
      // La primera carga la hace la pantalla; en cada reconexión se recupera lo perdido.
      if (readyOnce) handlers.current.onResync();
      readyOnce = true;
    });
    socket.on('staff.error', async (e: { code?: string }) => {
      if (e?.code === 'FORBIDDEN') {
        setState('forbidden');
        return;
      }
      if (e?.code === 'UNAUTHORIZED' && triedUnauthorized) {
        setState('reconnecting');
        return;
      }
      if (e?.code === 'UNAUTHORIZED') triedUnauthorized = true;
      // TOKEN_EXPIRED (o un token ya inválido): renovar y volver a conectar con el nuevo.
      setState('reconnecting');
      const before = getAccessToken();
      const ok = await refreshSession();
      if (disposed || !ok) return;
      const token = getAccessToken();
      // El listener de cambio de token ya pudo reconectar: solo si sigue inactivo.
      if (!socket.active || token === before) reconnectWith(token);
    });
    socket.on('disconnect', () => {
      if (!disposed) setState((s) => (s === 'forbidden' ? s : 'reconnecting'));
    });
    socket.on('connect_error', () => {
      if (!disposed) setState((s) => (s === 'forbidden' ? s : 'reconnecting'));
    });
    socket.on('rider.location', (data) => handlers.current.onEvent({ type: 'location', data }));
    socket.on('shipment.status', (data) => handlers.current.onEvent({ type: 'status', data }));
    socket.on('rider.presence', (data) => handlers.current.onEvent({ type: 'presence', data }));

    const off = onAccessTokenChange((token) => {
      const current = (socket.auth as { accessToken?: string | null }).accessToken;
      if (token && token !== current) reconnectWith(token);
    });
    if (getAccessToken()) socket.connect();

    return () => {
      disposed = true;
      off();
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [enabled]);

  return state;
}

/** Indicador "En vivo" / "Reconectando" para la cabecera de las pantallas en vivo. */
export function connectionTone(state: StaffConnection): 'ok' | 'warn' | 'danger' | 'neutral' {
  return state === 'live' ? 'ok' : state === 'forbidden' ? 'danger' : state === 'reconnecting' ? 'warn' : 'neutral';
}
