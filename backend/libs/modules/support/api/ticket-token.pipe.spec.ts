import { BadRequestException } from '@nestjs/common';
import { signTicketAccess } from '../domain/access-token';
import { TicketTokenPipe } from './ticket-token.pipe';

describe('TicketTokenPipe', () => {
  const pipe = new TicketTokenPipe();

  it('deja pasar un enlace firmado real', () => {
    const token = signTicketAccess('x'.repeat(32), '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 30);
    expect(pipe.transform(token)).toBe(token);
  });

  it.each([
    ['sin punto', 'abc'],
    ['tres partes', 'a.b.c'],
    ['caracteres fuera de base64url', 'ab+c.de/f'],
    ['demasiado largo', `${'a'.repeat(600)}.b`],
  ])('rechaza %s con 400', (_name, token) => {
    expect(() => pipe.transform(token)).toThrow(BadRequestException);
  });
});
