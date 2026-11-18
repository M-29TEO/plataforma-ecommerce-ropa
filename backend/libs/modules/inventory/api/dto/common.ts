import { Transform } from 'class-transformer';

/** Query strings llegan como texto: "true"/"false" → boolean (el resto lo rechaza @IsBoolean). */
export const ToBoolean = () =>
  Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value));
