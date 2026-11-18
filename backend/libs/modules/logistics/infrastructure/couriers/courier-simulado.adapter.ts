import {
  CourierApiQuote,
  CourierPort,
  CourierQuoteRequest,
  CourierShipmentRequest,
  CourierShipmentResult,
} from '../../application/ports';

interface SimQuoteResponse {
  quoteId: string;
  validUntil: string;
  options: { serviceCode: string; serviceName: string; price: string; etaHours: number | null }[];
}

interface SimShipment {
  trackingNumber: string;
  status: string;
  price: string;
}

/**
 * CourierPort → simulators/courier (ADR-10). En producción se agregaría un ServientregaAdapter
 * con la misma interfaz; el resto del módulo no cambia.
 */
export class CourierSimuladoAdapter extends CourierPort {
  readonly adapter = 'simulator';

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {
    super();
  }

  private async call<T>(path: string, init: { method: string; body?: unknown; signal: AbortSignal }): Promise<T> {
    // path es una constante del adaptador ('/v1/quotes', '/v1/shipments') y baseUrl viene de la config.
    // nosemgrep: moda-fetch-con-clave-sin-sanear
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: init.method,
      headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Courier simulado respondió HTTP ${res.status} en ${path}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  async quote(req: CourierQuoteRequest, signal: AbortSignal): Promise<CourierApiQuote[]> {
    const body = await this.call<SimQuoteResponse>('/v1/quotes', { method: 'POST', body: req, signal });
    return body.options.map((o) => ({
      serviceCode: o.serviceCode,
      price: o.price,
      etaHours: o.etaHours ?? null,
      raw: { quoteId: body.quoteId, validUntil: body.validUntil, option: o },
    }));
  }

  async createShipment(req: CourierShipmentRequest, signal: AbortSignal): Promise<CourierShipmentResult> {
    const body = await this.call<SimShipment>('/v1/shipments', { method: 'POST', body: req, signal });
    return { trackingNumber: body.trackingNumber, status: body.status, price: body.price, raw: body };
  }

  async getLabel(trackingNumber: string, signal: AbortSignal): Promise<Buffer> {
    const res = await fetch(`${this.baseUrl}/v1/shipments/${encodeURIComponent(trackingNumber)}/label.pdf`, {
      headers: { 'x-api-key': this.apiKey },
      signal,
    });
    if (!res.ok) throw new Error(`Courier simulado respondió HTTP ${res.status} al pedir la guía ${trackingNumber}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
