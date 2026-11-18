/** Helpers de la app del motorizado para los tests HTTP: entrega multipart con foto y firma. */
import request from 'supertest';

type Server = Parameters<typeof request>[0];

/** PNG de 1×1 válido (firma + IHDR + IDAT + IEND). */
export const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
/** Solo la cabecera JPEG (magic bytes FF D8 FF): el servidor valida el tipo, no decodifica la imagen. */
export const JPEG_TINY = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]), Buffer.alloc(64), Buffer.from([0xff, 0xd9])]);

export interface DeliverFields {
  lat: number;
  lng: number;
  receiverName?: string;
  otp?: string;
  codCollected?: string;
  codMethod?: string;
}

/**
 * POST /rider/shipments/:id/deliver en multipart. Por defecto adjunta foto (JPEG) y firma (PNG);
 * con photo/signature = null no se adjunta ese archivo.
 */
export function deliverMultipart(
  server: Server,
  auth: string,
  shipmentId: string,
  fields: DeliverFields,
  files: { photo?: Buffer | null; signature?: Buffer | null } = {},
) {
  let req = request(server).post(`/v1/rider/shipments/${shipmentId}/deliver`).set('Authorization', auth);
  const all: Record<string, string | number | undefined> = { receiverName: 'Lucía Torres', ...fields };
  for (const [k, v] of Object.entries(all)) if (v !== undefined) req = req.field(k, String(v));
  const photo = files.photo === undefined ? JPEG_TINY : files.photo;
  const signature = files.signature === undefined ? PNG_1X1 : files.signature;
  if (photo) req = req.attach('photo', photo, { filename: 'entrega.jpg', contentType: 'image/jpeg' });
  if (signature) req = req.attach('signature', signature, { filename: 'firma.png', contentType: 'image/png' });
  return req;
}
