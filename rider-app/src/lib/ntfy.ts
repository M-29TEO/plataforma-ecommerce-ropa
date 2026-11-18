/**
 * Suscripción al tópico privado de ntfy del motorizado (riders.ntfy_topic) por WebSocket
 * (GET /<tópico>/ws). El mensaje solo avisa que hay una oferta, sin datos del cliente (los
 * tópicos de ntfy son públicos para quien conozca el nombre): el detalle se pide a la API con
 * sesión (GET /rider/offers). Reconecta con espera creciente si se cae la red.
 */
export interface NtfyMessage {
  id: string;
  time: number;
  event: 'open' | 'keepalive' | 'message' | 'poll_request';
  topic: string;
  title?: string;
  message?: string;
  click?: string;
}

export function wsUrl(baseUrl: string, topic: string): string {
  const base = baseUrl.replace(/\/+$/, '').replace(/^http(s?):\/\//, (_m, s: string) => `ws${s}://`);
  return `${base}/${encodeURIComponent(topic)}/ws`;
}

/** Mensajes de ntfy (JSON por línea); cualquier otra cosa se ignora. */
export function parseNtfy(data: unknown): NtfyMessage | null {
  if (typeof data !== 'string') return null;
  try {
    const m = JSON.parse(data) as Partial<NtfyMessage>;
    if (typeof m !== 'object' || m === null || typeof m.event !== 'string' || typeof m.topic !== 'string') return null;
    return m as NtfyMessage;
  } catch {
    return null;
  }
}

export function backoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
}

type WsLike = {
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close(): void;
};

export interface NtfySubscriptionOptions {
  url: string;
  topic: string;
  onMessage: (m: NtfyMessage) => void;
  onStateChange?: (connected: boolean) => void;
  createSocket?: (url: string) => WsLike;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export function subscribeNtfy(opts: NtfySubscriptionOptions): () => void {
  const create = opts.createSocket ?? ((u: string) => new WebSocket(u) as unknown as WsLike);
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let socket: WsLike | null = null;
  let timer: unknown = null;
  let attempt = 0;
  let stopped = false;

  const connect = () => {
    if (stopped) return;
    const ws = create(wsUrl(opts.url, opts.topic));
    socket = ws;
    ws.onopen = () => {
      attempt = 0;
      opts.onStateChange?.(true);
    };
    ws.onmessage = (e) => {
      const m = parseNtfy(e.data);
      if (m && m.event === 'message' && m.topic === opts.topic) opts.onMessage(m);
    };
    ws.onerror = () => undefined;
    ws.onclose = () => {
      opts.onStateChange?.(false);
      if (stopped) return;
      timer = setTimer(connect, backoffMs(attempt++));
    };
  };
  connect();

  return () => {
    stopped = true;
    if (timer !== null) clearTimer(timer);
    socket?.close();
  };
}
