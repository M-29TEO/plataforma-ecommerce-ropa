import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAccessToken, hasSessionHint, refreshSession, setAccessToken } from './client';

const ok = () => new Response(JSON.stringify({ accessToken: 'nuevo', tokenType: 'Bearer', expiresIn: 900 }), { status: 200 });

describe('hasSessionHint', () => {
  afterEach(() => {
    document.cookie = 'session_hint=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
  });

  it('sin la cookie indicadora no hay sesión que renovar', () => {
    expect(hasSessionHint()).toBe(false);
  });

  it('con session_hint=1 sí', () => {
    document.cookie = 'otra=x; path=/';
    document.cookie = 'session_hint=1; path=/';
    expect(hasSessionHint()).toBe(true);
  });
});

describe('refreshSession', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    setAccessToken('viejo');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('un 429 no cierra la sesión: espera el Retry-After (máx. 5 s) y reintenta', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': '40' } })).mockResolvedValueOnce(ok());
    const result = refreshSession();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getAccessToken()).toBe('nuevo');
  });

  it('un 5xx o un corte de red se reintentan hasta 2 veces y no borran el token', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 502 })).mockRejectedValueOnce(new TypeError('red')).mockResolvedValueOnce(new Response(null, { status: 503 }));
    const result = refreshSession();
    await vi.advanceTimersByTimeAsync(4000);
    expect(await result).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(getAccessToken()).toBe('viejo');
  });

  it('un 401 cierra la sesión sin reintentar', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect(await refreshSession()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getAccessToken()).toBeNull();
  });
});
