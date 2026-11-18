/**
 * Puertos del orquestador de posventa: dónde se guardan las fotos de las devoluciones y cómo se
 * entrega al cliente el código de una gift card de saldo a favor.
 */
import { ObjectStorage } from '../../../shared-kernel';

/** Token de inyección para el ObjectStorage compartido (claves returns/photos/...). */
export abstract class ReturnPhotoStorage extends ObjectStorage {}

export interface StoreCreditMessage {
  to: string;
  customerName: string;
  rmaNumber: string;
  amount: string;
  /** Código en claro: solo existe en este mensaje (la base guarda su hash). */
  code: string;
  last4: string;
}

export abstract class StoreCreditMailer {
  abstract send(message: StoreCreditMessage): Promise<void>;
}
