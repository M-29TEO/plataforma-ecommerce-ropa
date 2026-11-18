import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { MAX_LOOKUP_IDS, VariantLookupQuery } from './admin.dto';

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

function parse(query: Record<string, unknown>) {
  const dto = plainToInstance(VariantLookupQuery, query);
  return { dto, errors: validateSync(dto) };
}

describe('VariantLookupQuery ?ids=', () => {
  it('separa por coma, recorta y descarta vacíos', () => {
    const { dto, errors } = parse({ ids: ` ${uuid(1)}, ,${uuid(2)} ` });
    expect(errors).toHaveLength(0);
    expect(dto.ids).toEqual([uuid(1), uuid(2)]);
  });

  it('acepta el parámetro repetido (ids=a&ids=b)', () => {
    const { dto, errors } = parse({ ids: [uuid(1), uuid(2)] });
    expect(errors).toHaveLength(0);
    expect(dto.ids).toEqual([uuid(1), uuid(2)]);
  });

  it(`rechaza más de ${MAX_LOOKUP_IDS} ids y los que no son uuid`, () => {
    const many = Array.from({ length: MAX_LOOKUP_IDS + 1 }, (_, i) => uuid(i)).join(',');
    expect(parse({ ids: many }).errors).toHaveLength(1);
    expect(parse({ ids: Array.from({ length: MAX_LOOKUP_IDS }, (_, i) => uuid(i)).join(',') }).errors).toHaveLength(0);
    expect(parse({ ids: `${uuid(1)},no-es-uuid` }).errors).toHaveLength(1);
  });

  it('sin ids sigue siendo opcional', () => {
    expect(parse({ barcode: '7861234567890' }).errors).toHaveLength(0);
  });
});
