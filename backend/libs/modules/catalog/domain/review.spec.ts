import { authorName, moderationFlags, normalizeAnswerBody, normalizeQuestionBody, normalizeReview } from './review';

describe('reseñas', () => {
  it('normaliza y valida la reseña', () => {
    expect(normalizeReview({ rating: 5, fitFeedback: 'true', title: '  Me encantó  ', body: 'La tela es suave y\n\n\n\nno destiñe.' })).toEqual({
      rating: 5,
      fitFeedback: 'true',
      title: 'Me encantó',
      body: 'La tela es suave y\n\nno destiñe.',
    });
    expect(normalizeReview({ rating: 3 })).toEqual({ rating: 3, fitFeedback: null, title: null, body: null });
    expect(() => normalizeReview({ rating: 0 })).toThrow(/rating/);
    expect(() => normalizeReview({ rating: 4.5 })).toThrow(/rating/);
    expect(() => normalizeReview({ rating: 4, fitFeedback: 'huge' })).toThrow(/fitFeedback/);
    expect(() => normalizeReview({ rating: 4, body: 'corta' })).toThrow(/body/);
  });

  it('marca datos de contacto, enlaces y lenguaje ofensivo para el moderador', () => {
    expect(moderationFlags('Excelente calidad, la recomiendo')).toEqual([]);
    expect(moderationFlags('Escríbeme a ana@correo.com o al 099 123 4567')).toEqual(['contains_email', 'contains_phone']);
    expect(moderationFlags('Más barato en www.otra-tienda.com')).toEqual(['contains_url']);
    expect(moderationFlags('Son unos ESTAFADORES')).toEqual(['blocked_word']);
    expect(moderationFlags('talla 38, me quedó bien')).toEqual([]);
  });

  it('muestra el autor como nombre e inicial, nunca el email', () => {
    expect(authorName('Ana', 'pérez')).toBe('Ana P.');
    expect(authorName('Ana', null)).toBe('Ana');
    expect(authorName(null, 'Pérez')).toBe('Cliente');
  });
});

describe('preguntas y respuestas', () => {
  it('valida largos', () => {
    expect(normalizeQuestionBody(' ¿La talla M es ajustada? ')).toBe('¿La talla M es ajustada?');
    expect(() => normalizeQuestionBody('¿Y?')).toThrow(/body/);
    expect(() => normalizeQuestionBody('')).toThrow(/Falta/);
    expect(normalizeAnswerBody('Sí')).toBe('Sí');
  });
});
