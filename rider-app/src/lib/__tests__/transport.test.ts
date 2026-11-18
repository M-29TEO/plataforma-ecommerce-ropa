import { ApiError, createApiClient, NetworkError, TokenStore } from '../api-client';
import { GpsQueue, toFix } from '../gps-queue';
import { backoffMs, parseNtfy, subscribeNtfy, wsUrl } from '../ntfy';

function memoryTokens(initial: string | null = 'old'): TokenStore & { value: string | null } {
  const store = {
    value: initial,
    async get() {
      return store.value;
    },
    async set(t: string | null) {
      store.value = t;
    },
  };
  return store;
}

const json = (status: number, body: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('cliente de la API', () => {
  it('manda el token y devuelve el JSON', async () => {
    const fetch = jest.fn().mockResolvedValue(json(200, { ok: true }));
    const api = createApiClient({ baseUrl: 'http://x/v1', tokens: memoryTokens('tok'), fetch });
    await expect(api('/rider/me')).resolves.toEqual({ ok: true });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('http://x/v1/rider/me');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(init.credentials).toBe('include');
  });

  it('con 401 renueva el token una vez y reintenta', async () => {
    const tokens = memoryTokens('old');
    const fetch = jest
      .fn()
      .mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHORIZED', message: 'x' } }))
      .mockResolvedValueOnce(json(200, { accessToken: 'new', tokenType: 'Bearer', expiresIn: 900 }))
      .mockResolvedValueOnce(json(200, [1, 2]));
    const api = createApiClient({ baseUrl: 'http://x/v1', tokens, fetch });
    await expect(api('/rider/offers')).resolves.toEqual([1, 2]);
    expect(fetch.mock.calls[1][0]).toBe('http://x/v1/auth/refresh');
    expect(fetch.mock.calls[2][1].headers.Authorization).toBe('Bearer new');
    expect(tokens.value).toBe('new');
  });

  it('si el refresh falla, cierra la sesión', async () => {
    const tokens = memoryTokens('old');
    const expired = jest.fn();
    const fetch = jest.fn().mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHORIZED', message: 'x' } })).mockResolvedValueOnce(json(401, { error: { code: 'REFRESH_INVALID', message: 'x' } }));
    const api = createApiClient({ baseUrl: 'http://x/v1', tokens, fetch, onSessionExpired: expired });
    await expect(api('/rider/me')).rejects.toBeInstanceOf(ApiError);
    expect(expired).toHaveBeenCalled();
    expect(tokens.value).toBeNull();
  });

  it('el login no intenta renovar y expone el código de error', async () => {
    const fetch = jest.fn().mockResolvedValue(json(401, { error: { code: 'INVALID_CREDENTIALS', message: 'Credenciales inválidas', details: {} } }));
    const api = createApiClient({ baseUrl: 'http://x/v1', tokens: memoryTokens(null), fetch });
    await expect(api('/auth/login', { body: {}, auth: false })).rejects.toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('204 sin cuerpo y errores de red', async () => {
    const api204 = createApiClient({ baseUrl: 'http://x/v1', tokens: memoryTokens(), fetch: jest.fn().mockResolvedValue(new Response(null, { status: 204 })) });
    await expect(api204('/rider/offers/1/reject', { body: {} })).resolves.toBeUndefined();
    const apiDown = createApiClient({ baseUrl: 'http://x/v1', tokens: memoryTokens(), fetch: jest.fn().mockRejectedValue(new TypeError('Network request failed')) });
    await expect(apiDown('/rider/me')).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('cola de GPS', () => {
  const fix = (t: number) => ({ lat: -0.18, lng: -78.47, timestamp: t });

  it('deja una posición cada ~10 s', () => {
    const q = new GpsQueue(jest.fn(), 10_000);
    expect(q.add([fix(0), fix(3_000), fix(9_500), fix(12_000), fix(21_000)])).toBe(3); // 0, 9.5 s y 21 s
  });

  it('envía en orden y guarda lo que no salió por falta de red', async () => {
    const now = 100_000;
    const send = jest.fn().mockResolvedValueOnce({ openOffers: 0 }).mockRejectedValueOnce(new NetworkError()).mockResolvedValue({ openOffers: 2 });
    const q = new GpsQueue(send, 10_000);
    q.add([fix(now - 20_000), fix(now - 10_000)]);
    expect(await q.flush(now)).toMatchObject({ sent: 1, openOffers: 0 });
    expect(q.size).toBe(1);
    expect(await q.flush(now)).toMatchObject({ sent: 1, openOffers: 2 });
    expect(q.size).toBe(0);
  });

  it('descarta posiciones viejas o rechazadas y avisa si venció la sesión', async () => {
    const now = 10 * 60 * 60_000;
    const send = jest.fn().mockRejectedValueOnce(new ApiError(422, 'POSITION_OUT_OF_RANGE', 'x')).mockRejectedValueOnce(new ApiError(401, 'UNAUTHORIZED', 'x'));
    const q = new GpsQueue(send, 10_000);
    q.add([fix(now - 2 * 60 * 60_000), fix(now - 20_000), fix(now - 5_000)]);
    const r = await q.flush(now);
    expect(r).toMatchObject({ dropped: 2, sessionExpired: true, sent: 0 });
    expect(q.size).toBe(1);
  });

  it('convierte la posición de expo-location', () => {
    expect(toFix({ timestamp: 5, coords: { latitude: 1, longitude: 2, heading: -1, speed: 10, accuracy: 7.6 } })).toEqual({
      lat: 1,
      lng: 2,
      heading: undefined,
      speedKmh: 36,
      accuracyM: 8,
      timestamp: 5,
    });
  });
});

describe('ntfy', () => {
  it('arma la URL del WebSocket', () => {
    expect(wsUrl('http://192.168.1.20:8090/', 'rider-abc')).toBe('ws://192.168.1.20:8090/rider-abc/ws');
    expect(wsUrl('https://ntfy.moda.ec', 'rider-abc')).toBe('wss://ntfy.moda.ec/rider-abc/ws');
  });

  it('interpreta solo mensajes de ntfy', () => {
    expect(parseNtfy('{"id":"a","time":1,"event":"message","topic":"t","title":"Nueva oferta"}')?.title).toBe('Nueva oferta');
    expect(parseNtfy('no json')).toBeNull();
    expect(parseNtfy('{"foo":1}')).toBeNull();
  });

  it('reconecta con espera creciente y entrega los mensajes del tópico', () => {
    const sockets: Array<{ onopen: any; onmessage: any; onclose: any; onerror: any; close: jest.Mock }> = [];
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const onMessage = jest.fn();
    const stop = subscribeNtfy({
      url: 'http://n',
      topic: 't',
      onMessage,
      createSocket: () => {
        const s = { onopen: null, onmessage: null, onclose: null, onerror: null, close: jest.fn() };
        sockets.push(s);
        return s;
      },
      setTimer: (fn, ms) => timers.push({ fn, ms }),
      clearTimer: () => undefined,
    });
    sockets[0].onopen();
    sockets[0].onmessage({ data: JSON.stringify({ id: '1', time: 1, event: 'keepalive', topic: 't' }) });
    sockets[0].onmessage({ data: JSON.stringify({ id: '2', time: 1, event: 'message', topic: 't', title: 'x' }) });
    expect(onMessage).toHaveBeenCalledTimes(1);
    sockets[0].onclose();
    expect(timers[0].ms).toBe(backoffMs(0));
    timers[0].fn();
    expect(sockets).toHaveLength(2);
    stop();
    expect(sockets[1].close).toHaveBeenCalled();
    sockets[1].onclose();
    expect(timers).toHaveLength(1);
  });
});
