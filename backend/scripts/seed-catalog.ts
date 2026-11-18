/**
 * Catálogo de demostración para el storefront: 5 marcas (inventadas), 8 colores, tallas alfa,
 * numéricas y única, 3 guías de tallas, 14 categorías y 49 productos (50 con la camiseta básica de
 * seed-dev) con variantes por color y talla, fotos por color, costo (para el margen de los reportes)
 * y stock en la bodega de Quito. Lo usa `npm run seed:dev`.
 *
 * Las fotos son ilustraciones SVG generadas por el storefront (storefront/scripts/generate-demo-images.mjs)
 * y servidas en /media/demo/<prenda>-<color>[-detalle].svg: sin fotos de terceros ni licencias.
 *
 * Idempotente: todo se identifica por slug, nombre o SKU (ON CONFLICT ... DO UPDATE).
 */
import { Queryable } from '../libs/shared-kernel';

const BRANDS = [
  ['andina-studio', 'Andina Studio'],
  ['costa-azul', 'Costa Azul'],
  ['volcan-denim', 'Volcán Denim'],
  ['tejidos-del-sur', 'Tejidos del Sur'],
  ['nan', 'Ñan'],
] as const;

export const DEMO_COLORS: ReadonlyArray<{ name: string; slug: string; hex: string; family: string }> = [
  { name: 'Negro', slug: 'negro', hex: '#1C1C1E', family: 'neutro' },
  { name: 'Blanco', slug: 'blanco', hex: '#F4F1EA', family: 'neutro' },
  { name: 'Beige', slug: 'beige', hex: '#D8C3A5', family: 'neutro' },
  { name: 'Azul marino', slug: 'azul-marino', hex: '#22315A', family: 'azul' },
  { name: 'Celeste', slug: 'celeste', hex: '#8DB8DE', family: 'azul' },
  { name: 'Rojo', slug: 'rojo', hex: '#B3262E', family: 'rojo' },
  { name: 'Verde oliva', slug: 'verde-oliva', hex: '#5E6B3A', family: 'verde' },
  { name: 'Terracota', slug: 'terracota', hex: '#C0643F', family: 'naranja' },
];

const ALPHA = ['XS', 'S', 'M', 'L', 'XL'];
const NUMERIC = ['28', '30', '32', '34', '36'];
/** Accesorios y ponchos: una sola talla (sistema alfa, después de XL). */
const UNIQUE = 'Única';

const CATEGORIES: ReadonlyArray<[path: string, name: string, sort: number]> = [
  ['mujer', 'Mujer', 1],
  ['mujer/vestidos', 'Vestidos', 1],
  ['mujer/blusas', 'Blusas', 2],
  ['mujer/jeans', 'Jeans', 3],
  ['mujer/chaquetas', 'Chaquetas', 4],
  ['mujer/faldas', 'Faldas', 5],
  ['mujer/pantalones', 'Pantalones y shorts', 6],
  ['hombre', 'Hombre', 2],
  ['hombre/camisas', 'Camisas', 1],
  ['hombre/jeans', 'Jeans', 2],
  ['hombre/chaquetas', 'Chaquetas', 3],
  ['hombre/pantalones', 'Pantalones', 4],
  ['hombre/shorts', 'Shorts y bermudas', 5],
  ['unisex', 'Unisex', 3],
  ['unisex/camisetas', 'Camisetas', 1],
  ['unisex/sudaderas', 'Sudaderas', 2],
  ['unisex/accesorios', 'Accesorios', 3],
];

const SIZE_CHARTS = {
  tops_women: {
    name: 'Mujer · partes de arriba y vestidos',
    data: {
      unit: 'cm',
      columns: ['Talla', 'Busto', 'Cintura', 'Cadera'],
      rows: [
        ['XS', '80-84', '62-66', '86-90'],
        ['S', '85-89', '67-71', '91-95'],
        ['M', '90-94', '72-76', '96-100'],
        ['L', '95-100', '77-82', '101-106'],
        ['XL', '101-106', '83-88', '107-112'],
      ],
      howToMeasure: [
        'Busto: mide alrededor de la parte más llena del pecho, con la cinta horizontal.',
        'Cintura: mide en la parte más angosta, sin apretar.',
        'Cadera: mide alrededor de la parte más ancha, con los pies juntos.',
      ],
    },
  },
  tops_men: {
    name: 'Hombre y unisex · partes de arriba',
    data: {
      unit: 'cm',
      columns: ['Talla', 'Pecho', 'Cintura', 'Largo de manga'],
      rows: [
        ['XS', '84-88', '70-74', '60'],
        ['S', '89-94', '75-80', '62'],
        ['M', '95-100', '81-86', '63'],
        ['L', '101-107', '87-93', '64'],
        ['XL', '108-114', '94-100', '65'],
      ],
      howToMeasure: [
        'Pecho: mide alrededor de la parte más ancha, bajo las axilas.',
        'Manga: del centro de la nuca al puño, con el brazo un poco doblado.',
      ],
    },
  },
  jeans: {
    name: 'Jeans y pantalones',
    data: {
      unit: 'cm',
      columns: ['Talla', 'Cintura', 'Cadera', 'Largo de entrepierna'],
      rows: [
        ['28', '71', '90', '78'],
        ['30', '76', '95', '79'],
        ['32', '81', '100', '80'],
        ['34', '86', '105', '81'],
        ['36', '91', '110', '82'],
      ],
      howToMeasure: ['Cintura: donde normalmente usas el pantalón.', 'Entrepierna: del centro de la entrepierna al tobillo.'],
    },
  },
} as const;

type Chart = keyof typeof SIZE_CHARTS;
/** Prenda de la ilustración: storefront/scripts/generate-demo-images.mjs dibuja una por tipo. */
type Garment = 'vestido' | 'blusa' | 'jean' | 'chaqueta' | 'camisa' | 'camiseta' | 'sudadera' | 'falda' | 'pantalon' | 'short' | 'abrigo' | 'gorra' | 'bufanda';

interface DemoProduct {
  code: string;
  slug: string;
  name: string;
  category: string;
  brand: (typeof BRANDS)[number][0];
  gender: 'women' | 'men' | 'unisex';
  garment: Garment;
  price: string;
  compareAt?: string;
  material: string;
  care: string;
  description: string;
  colors: string[];
  sizes: 'alpha' | 'numeric' | 'unique';
  /** Sin guía en talla única. */
  chart?: Chart;
  fit?: string;
}

const CARE_COTTON = 'Lavar a máquina en frío con colores similares. No usar blanqueador. Secar a la sombra.';
const CARE_DELICATE = 'Lavar a mano o en ciclo delicado. Planchar a temperatura baja. No usar secadora.';
const CARE_DENIM = 'Lavar del revés en agua fría. Secar colgado para conservar el color.';

export const DEMO_PRODUCTS: DemoProduct[] = [
  { code: 'VMI', slug: 'vestido-midi-lino', name: 'Vestido midi de lino', category: 'mujer/vestidos', brand: 'costa-azul', gender: 'women', garment: 'vestido', price: '54.90', compareAt: '69.90', material: '100 % lino', care: CARE_DELICATE, description: 'Vestido midi de lino con escote en V y cinturón del mismo tejido. Fresco para el calor de la Costa y elegante para una tarde en la Sierra.', colors: ['Beige', 'Terracota', 'Negro'], sizes: 'alpha', chart: 'tops_women', fit: 'Holgado' },
  { code: 'VCA', slug: 'vestido-camisero-algodon', name: 'Vestido camisero de algodón', category: 'mujer/vestidos', brand: 'andina-studio', gender: 'women', garment: 'vestido', price: '44.90', material: '100 % algodón orgánico', care: CARE_COTTON, description: 'Vestido camisero con botones al frente, bolsillos laterales y manga recogible. Se lleva suelto o con cinturón.', colors: ['Celeste', 'Blanco', 'Verde oliva'], sizes: 'alpha', chart: 'tops_women', fit: 'Regular' },
  { code: 'VFL', slug: 'vestido-floral-envolvente', name: 'Vestido envolvente estampado', category: 'mujer/vestidos', brand: 'nan', gender: 'women', garment: 'vestido', price: '49.00', compareAt: '59.00', material: '100 % viscosa', care: CARE_DELICATE, description: 'Vestido envolvente con lazo a la cintura y caída fluida. Estampado inspirado en los tejidos de Otavalo.', colors: ['Rojo', 'Azul marino'], sizes: 'alpha', chart: 'tops_women', fit: 'Ajustado a la cintura' },
  { code: 'FPL', slug: 'falda-plisada-midi', name: 'Falda plisada midi', category: 'mujer/faldas', brand: 'costa-azul', gender: 'women', garment: 'falda', price: '36.90', material: '100 % poliéster reciclado', care: CARE_DELICATE, description: 'Falda plisada con cintura elástica que no marca. Movimiento ligero y largo a media pierna.', colors: ['Negro', 'Beige', 'Verde oliva'], sizes: 'alpha', chart: 'tops_women' },
  { code: 'BSE', slug: 'blusa-seda-manga-larga', name: 'Blusa satinada manga larga', category: 'mujer/blusas', brand: 'andina-studio', gender: 'women', garment: 'blusa', price: '39.90', material: '95 % poliéster, 5 % elastano', care: CARE_DELICATE, description: 'Blusa satinada con cuello redondo y puños con botón. Va de la oficina a la cena sin cambiarse.', colors: ['Blanco', 'Negro', 'Terracota'], sizes: 'alpha', chart: 'tops_women' },
  { code: 'BBO', slug: 'blusa-bordada-otavalo', name: 'Blusa bordada a mano', category: 'mujer/blusas', brand: 'tejidos-del-sur', gender: 'women', garment: 'blusa', price: '32.00', material: '100 % algodón', care: CARE_DELICATE, description: 'Blusa de algodón con bordado floral hecho a mano por artesanas de Imbabura. Cada pieza es única.', colors: ['Blanco', 'Celeste'], sizes: 'alpha', chart: 'tops_women', fit: 'Holgado' },
  { code: 'BLI', slug: 'blusa-lino-sin-mangas', name: 'Blusa de lino sin mangas', category: 'mujer/blusas', brand: 'costa-azul', gender: 'women', garment: 'blusa', price: '27.90', compareAt: '34.90', material: '100 % lino', care: CARE_DELICATE, description: 'Blusa de lino sin mangas con botones de coco. Imprescindible para la playa.', colors: ['Beige', 'Blanco', 'Rojo'], sizes: 'alpha', chart: 'tops_women' },
  { code: 'JMT', slug: 'jean-mom-tiro-alto', name: 'Jean mom de tiro alto', category: 'mujer/jeans', brand: 'volcan-denim', gender: 'women', garment: 'jean', price: '46.90', material: '98 % algodón, 2 % elastano', care: CARE_DENIM, description: 'Jean de tiro alto con pierna recta y tobillo al descubierto. Denim con un toque de elasticidad.', colors: ['Celeste', 'Azul marino', 'Negro'], sizes: 'numeric', chart: 'jeans', fit: 'Recto' },
  { code: 'JWL', slug: 'jean-wide-leg', name: 'Jean wide leg', category: 'mujer/jeans', brand: 'volcan-denim', gender: 'women', garment: 'jean', price: '52.00', compareAt: '64.00', material: '100 % algodón', care: CARE_DENIM, description: 'Jean de pierna ancha y cintura alta, con costuras marcadas al frente.', colors: ['Azul marino', 'Blanco'], sizes: 'numeric', chart: 'jeans', fit: 'Ancho' },
  { code: 'CHM', slug: 'chaqueta-mezclilla-mujer', name: 'Chaqueta de mezclilla', category: 'mujer/chaquetas', brand: 'volcan-denim', gender: 'women', garment: 'chaqueta', price: '58.90', material: '100 % algodón', care: CARE_DENIM, description: 'Chaqueta de mezclilla clásica con bolsillos de parche y botones metálicos.', colors: ['Celeste', 'Negro'], sizes: 'alpha', chart: 'tops_women' },
  { code: 'CHP', slug: 'chaqueta-paramo-alpaca', name: 'Chaqueta páramo de alpaca', category: 'mujer/chaquetas', brand: 'tejidos-del-sur', gender: 'women', garment: 'chaqueta', price: '89.00', material: '60 % alpaca, 40 % lana', care: 'Lavar a mano en agua fría con jabón neutro. Secar en plano.', description: 'Chaqueta tejida de alpaca para las mañanas frías de Quito y Cuenca. Abrigada sin pesar.', colors: ['Beige', 'Terracota', 'Verde oliva'], sizes: 'alpha', chart: 'tops_women' },
  { code: 'COX', slug: 'camisa-oxford-hombre', name: 'Camisa Oxford', category: 'hombre/camisas', brand: 'andina-studio', gender: 'men', garment: 'camisa', price: '38.90', material: '100 % algodón Oxford', care: CARE_COTTON, description: 'Camisa Oxford de cuello abotonado. La base de cualquier armario, con o sin corbata.', colors: ['Blanco', 'Celeste', 'Azul marino'], sizes: 'alpha', chart: 'tops_men', fit: 'Slim' },
  { code: 'CLI', slug: 'camisa-lino-guayabera', name: 'Camisa de lino tipo guayabera', category: 'hombre/camisas', brand: 'costa-azul', gender: 'men', garment: 'camisa', price: '42.00', compareAt: '52.00', material: '100 % lino', care: CARE_DELICATE, description: 'Camisa de lino con alforzas y cuatro bolsillos, inspirada en la guayabera de la Costa.', colors: ['Blanco', 'Beige'], sizes: 'alpha', chart: 'tops_men', fit: 'Regular' },
  { code: 'CFR', slug: 'camisa-franela-cuadros', name: 'Camisa de franela a cuadros', category: 'hombre/camisas', brand: 'nan', gender: 'men', garment: 'camisa', price: '34.90', material: '100 % algodón cepillado', care: CARE_COTTON, description: 'Camisa de franela suave con estampado a cuadros. Para los días nublados.', colors: ['Rojo', 'Verde oliva', 'Azul marino'], sizes: 'alpha', chart: 'tops_men' },
  { code: 'JSL', slug: 'jean-slim-hombre', name: 'Jean slim', category: 'hombre/jeans', brand: 'volcan-denim', gender: 'men', garment: 'jean', price: '44.90', material: '98 % algodón, 2 % elastano', care: CARE_DENIM, description: 'Jean de corte slim con tiro medio. Cómodo todo el día gracias al elastano.', colors: ['Azul marino', 'Negro', 'Celeste'], sizes: 'numeric', chart: 'jeans', fit: 'Slim' },
  { code: 'JRE', slug: 'jean-recto-clasico', name: 'Jean recto clásico', category: 'hombre/jeans', brand: 'volcan-denim', gender: 'men', garment: 'jean', price: '39.90', compareAt: '49.90', material: '100 % algodón', care: CARE_DENIM, description: 'Jean recto de cinco bolsillos en denim rígido que se amolda con el uso.', colors: ['Azul marino', 'Celeste'], sizes: 'numeric', chart: 'jeans', fit: 'Recto' },
  { code: 'CBO', slug: 'chaqueta-bomber-hombre', name: 'Chaqueta bomber', category: 'hombre/chaquetas', brand: 'nan', gender: 'men', garment: 'chaqueta', price: '64.90', material: 'Exterior 100 % nailon, forro 100 % poliéster', care: 'Lavar en ciclo delicado. No planchar.', description: 'Chaqueta bomber liviana con puños elásticos y bolsillo interior. Rompevientos.', colors: ['Verde oliva', 'Negro', 'Azul marino'], sizes: 'alpha', chart: 'tops_men' },
  { code: 'CPA', slug: 'chaqueta-acolchada-paramo', name: 'Chaqueta acolchada', category: 'hombre/chaquetas', brand: 'andina-studio', gender: 'men', garment: 'chaqueta', price: '79.00', compareAt: '95.00', material: 'Relleno sintético reciclado', care: 'Lavar en frío. Secar en secadora a baja temperatura con dos pelotas de tenis.', description: 'Chaqueta acolchada con capucha desmontable, pensada para el frío del páramo.', colors: ['Negro', 'Terracota'], sizes: 'alpha', chart: 'tops_men' },
  { code: 'TBA', slug: 'camiseta-basica-organica', name: 'Camiseta básica orgánica', category: 'unisex/camisetas', brand: 'andina-studio', gender: 'unisex', garment: 'camiseta', price: '16.90', material: '100 % algodón orgánico', care: CARE_COTTON, description: 'Camiseta de cuello redondo en algodón orgánico de 180 g. No se deforma con los lavados.', colors: ['Blanco', 'Negro', 'Beige', 'Azul marino', 'Verde oliva'], sizes: 'alpha', chart: 'tops_men', fit: 'Regular' },
  { code: 'TEC', slug: 'camiseta-estampada-ecuador', name: 'Camiseta estampada Mitad del Mundo', category: 'unisex/camisetas', brand: 'nan', gender: 'unisex', garment: 'camiseta', price: '19.90', compareAt: '24.90', material: '100 % algodón', care: CARE_COTTON, description: 'Camiseta con estampado de la línea equinoccial en tinta al agua.', colors: ['Blanco', 'Terracota'], sizes: 'alpha', chart: 'tops_men' },
  { code: 'TPO', slug: 'camiseta-polo-pique', name: 'Polo de piqué', category: 'unisex/camisetas', brand: 'costa-azul', gender: 'unisex', garment: 'camiseta', price: '26.90', material: '100 % algodón piqué', care: CARE_COTTON, description: 'Polo de piqué con tres botones y cuello de punto.', colors: ['Azul marino', 'Blanco', 'Rojo'], sizes: 'alpha', chart: 'tops_men' },
  { code: 'SCA', slug: 'sudadera-capucha', name: 'Sudadera con capucha', category: 'unisex/sudaderas', brand: 'nan', gender: 'unisex', garment: 'sudadera', price: '42.90', material: '80 % algodón, 20 % poliéster', care: CARE_COTTON, description: 'Sudadera de felpa perchada con capucha forrada y bolsillo canguro.', colors: ['Negro', 'Beige', 'Verde oliva'], sizes: 'alpha', chart: 'tops_men', fit: 'Holgado' },
  { code: 'SCR', slug: 'sudadera-cuello-redondo', name: 'Sudadera cuello redondo', category: 'unisex/sudaderas', brand: 'andina-studio', gender: 'unisex', garment: 'sudadera', price: '36.90', compareAt: '44.90', material: '100 % algodón orgánico', care: CARE_COTTON, description: 'Sudadera clásica de cuello redondo con puños y bajo acanalados.', colors: ['Azul marino', 'Terracota', 'Blanco'], sizes: 'alpha', chart: 'tops_men' },
  { code: 'SAL', slug: 'sueter-alpaca-trenzado', name: 'Suéter trenzado de alpaca', category: 'unisex/sudaderas', brand: 'tejidos-del-sur', gender: 'unisex', garment: 'sudadera', price: '74.00', material: '70 % alpaca, 30 % lana', care: 'Lavar a mano en agua fría. Secar en plano.', description: 'Suéter de punto trenzado tejido en Cotacachi con fibra de alpaca.', colors: ['Beige', 'Blanco', 'Rojo'], sizes: 'alpha', chart: 'tops_men' },
  // Ampliación para la demo (scripts/seed-demo.ts): 25 productos más; con la camiseta básica, 50.
  { code: 'FME', slug: 'falda-mezclilla-midi', name: 'Falda midi de mezclilla', category: 'mujer/faldas', brand: 'volcan-denim', gender: 'women', garment: 'falda', price: '34.90', material: '100 % algodón', care: CARE_DENIM, description: 'Falda midi de mezclilla con abertura delantera y botones metálicos al frente.', colors: ['Celeste', 'Azul marino'], sizes: 'alpha', chart: 'tops_women' },
  { code: 'FSA', slug: 'falda-satinada-larga', name: 'Falda satinada larga', category: 'mujer/faldas', brand: 'andina-studio', gender: 'women', garment: 'falda', price: '39.90', compareAt: '49.90', material: '100 % poliéster satinado', care: CARE_DELICATE, description: 'Falda larga de satín con cintura elástica y caída al bies. Brilla sin exagerar.', colors: ['Verde oliva', 'Negro', 'Beige'], sizes: 'alpha', chart: 'tops_women' },
  { code: 'PPA', slug: 'pantalon-palazzo-lino', name: 'Pantalón palazzo de lino', category: 'mujer/pantalones', brand: 'costa-azul', gender: 'women', garment: 'pantalon', price: '42.90', material: '100 % lino', care: CARE_DELICATE, description: 'Pantalón palazzo de pierna amplia y cintura alta con jareta. Fresco para todo el día.', colors: ['Beige', 'Blanco', 'Terracota'], sizes: 'alpha', chart: 'tops_women', fit: 'Ancho' },
  { code: 'PSA', slug: 'pantalon-sastre-cintura-alta', name: 'Pantalón sastre de cintura alta', category: 'mujer/pantalones', brand: 'andina-studio', gender: 'women', garment: 'pantalon', price: '48.00', material: '68 % poliéster, 30 % viscosa, 2 % elastano', care: CARE_DELICATE, description: 'Pantalón de vestir con pinzas, pierna recta y bolsillos laterales. Para la oficina y más allá.', colors: ['Negro', 'Azul marino', 'Beige'], sizes: 'numeric', chart: 'jeans', fit: 'Recto' },
  { code: 'SMU', slug: 'short-mezclilla-mujer', name: 'Short de mezclilla', category: 'mujer/pantalones', brand: 'volcan-denim', gender: 'women', garment: 'short', price: '26.90', compareAt: '32.90', material: '100 % algodón', care: CARE_DENIM, description: 'Short de tiro alto con basta deshilachada. El favorito para la playa en Montañita.', colors: ['Celeste', 'Blanco'], sizes: 'numeric', chart: 'jeans' },
  { code: 'VTU', slug: 'vestido-tubo-punto', name: 'Vestido tubo de punto', category: 'mujer/vestidos', brand: 'nan', gender: 'women', garment: 'vestido', price: '45.90', material: '95 % viscosa, 5 % elastano', care: CARE_DELICATE, description: 'Vestido tubo de punto suave con cuello alto. Se ajusta sin apretar.', colors: ['Negro', 'Rojo', 'Azul marino'], sizes: 'alpha', chart: 'tops_women', fit: 'Ajustado' },
  { code: 'VCO', slug: 'vestido-corto-algodon', name: 'Vestido corto de algodón', category: 'mujer/vestidos', brand: 'costa-azul', gender: 'women', garment: 'vestido', price: '34.90', material: '100 % algodón', care: CARE_COTTON, description: 'Vestido corto con tirantes regulables y falda con vuelo. Para el sol de la Costa.', colors: ['Blanco', 'Celeste', 'Terracota'], sizes: 'alpha', chart: 'tops_women' },
  { code: 'BCA', slug: 'blusa-campesina-algodon', name: 'Blusa campesina de algodón', category: 'mujer/blusas', brand: 'tejidos-del-sur', gender: 'women', garment: 'blusa', price: '29.90', material: '100 % algodón', care: CARE_COTTON, description: 'Blusa de hombros descubiertos con elástico y mangas abullonadas.', colors: ['Blanco', 'Rojo', 'Beige'], sizes: 'alpha', chart: 'tops_women', fit: 'Holgado' },
  { code: 'ATR', slug: 'gabardina-clasica', name: 'Gabardina clásica', category: 'mujer/chaquetas', brand: 'andina-studio', gender: 'women', garment: 'abrigo', price: '96.00', compareAt: '119.00', material: '65 % algodón, 35 % poliéster', care: 'Limpieza en seco o lavado delicado en frío.', description: 'Gabardina cruzada con cinturón y hombreras suaves. Repele la garúa quiteña.', colors: ['Beige', 'Negro'], sizes: 'alpha', chart: 'tops_women' },
  { code: 'PCH', slug: 'pantalon-chino-hombre', name: 'Pantalón chino', category: 'hombre/pantalones', brand: 'andina-studio', gender: 'men', garment: 'pantalon', price: '39.90', material: '98 % algodón, 2 % elastano', care: CARE_COTTON, description: 'Pantalón chino de corte slim con bolsillos sesgados. Va con camisa o camiseta.', colors: ['Beige', 'Azul marino', 'Verde oliva', 'Negro'], sizes: 'numeric', chart: 'jeans', fit: 'Slim' },
  { code: 'PCA', slug: 'pantalon-cargo', name: 'Pantalón cargo', category: 'hombre/pantalones', brand: 'nan', gender: 'men', garment: 'pantalon', price: '44.90', compareAt: '54.90', material: '100 % algodón ripstop', care: CARE_COTTON, description: 'Pantalón cargo con seis bolsillos y bastas con cordón ajustable.', colors: ['Verde oliva', 'Negro', 'Beige'], sizes: 'numeric', chart: 'jeans', fit: 'Holgado' },
  { code: 'PJG', slug: 'jogger-algodon', name: 'Jogger de algodón', category: 'hombre/pantalones', brand: 'nan', gender: 'men', garment: 'pantalon', price: '32.90', material: '80 % algodón, 20 % poliéster', care: CARE_COTTON, description: 'Jogger de felpa con puños elásticos y cintura con cordón. Para entrenar o descansar.', colors: ['Negro', 'Azul marino', 'Beige'], sizes: 'alpha', chart: 'tops_men' },
  { code: 'SBE', slug: 'bermuda-chino', name: 'Bermuda chino', category: 'hombre/shorts', brand: 'costa-azul', gender: 'men', garment: 'short', price: '27.90', material: '100 % algodón', care: CARE_COTTON, description: 'Bermuda chino sobre la rodilla con basta doblada.', colors: ['Beige', 'Azul marino', 'Celeste'], sizes: 'numeric', chart: 'jeans' },
  { code: 'SBA', slug: 'short-de-bano', name: 'Short de baño', category: 'hombre/shorts', brand: 'costa-azul', gender: 'men', garment: 'short', price: '24.90', compareAt: '29.90', material: '100 % poliéster de secado rápido', care: 'Enjuagar con agua dulce después del mar o la piscina.', description: 'Short de baño con malla interior y bolsillo trasero con velcro.', colors: ['Rojo', 'Celeste', 'Verde oliva'], sizes: 'alpha', chart: 'tops_men' },
  { code: 'CMC', slug: 'camisa-manga-corta-estampada', name: 'Camisa manga corta estampada', category: 'hombre/camisas', brand: 'costa-azul', gender: 'men', garment: 'camisa', price: '33.90', material: '100 % viscosa', care: CARE_DELICATE, description: 'Camisa de manga corta con cuello cubano y estampado de hojas de banano.', colors: ['Verde oliva', 'Azul marino', 'Blanco'], sizes: 'alpha', chart: 'tops_men', fit: 'Regular' },
  { code: 'CDE', slug: 'camisa-mezclilla', name: 'Camisa de mezclilla', category: 'hombre/camisas', brand: 'volcan-denim', gender: 'men', garment: 'camisa', price: '41.90', material: '100 % algodón', care: CARE_DENIM, description: 'Camisa de mezclilla liviana con dos bolsillos de parche y broches.', colors: ['Celeste', 'Azul marino'], sizes: 'alpha', chart: 'tops_men' },
  { code: 'AHO', slug: 'abrigo-pano-hombre', name: 'Abrigo de paño', category: 'hombre/chaquetas', brand: 'tejidos-del-sur', gender: 'men', garment: 'abrigo', price: '119.00', compareAt: '139.00', material: '70 % lana, 30 % poliamida', care: 'Limpieza en seco.', description: 'Abrigo largo de paño con solapa en pico y forro interior. Para las noches frías de la Sierra.', colors: ['Negro', 'Azul marino', 'Beige'], sizes: 'alpha', chart: 'tops_men' },
  { code: 'JRL', slug: 'jean-relaxed-hombre', name: 'Jean relaxed', category: 'hombre/jeans', brand: 'volcan-denim', gender: 'men', garment: 'jean', price: '42.90', material: '100 % algodón', care: CARE_DENIM, description: 'Jean de corte relajado con más espacio en muslo y rodilla.', colors: ['Azul marino', 'Negro'], sizes: 'numeric', chart: 'jeans', fit: 'Relajado' },
  { code: 'TOV', slug: 'camiseta-oversize', name: 'Camiseta oversize', category: 'unisex/camisetas', brand: 'nan', gender: 'unisex', garment: 'camiseta', price: '21.90', material: '100 % algodón peinado 220 g', care: CARE_COTTON, description: 'Camiseta de hombros caídos y cuerpo amplio en algodón grueso.', colors: ['Negro', 'Beige', 'Blanco', 'Verde oliva'], sizes: 'alpha', chart: 'tops_men', fit: 'Oversize' },
  { code: 'TML', slug: 'camiseta-manga-larga', name: 'Camiseta manga larga', category: 'unisex/camisetas', brand: 'andina-studio', gender: 'unisex', garment: 'camiseta', price: '22.90', material: '100 % algodón orgánico', care: CARE_COTTON, description: 'Camiseta de manga larga con puños acanalados. La primera capa para el clima cambiante de Quito.', colors: ['Blanco', 'Azul marino', 'Terracota'], sizes: 'alpha', chart: 'tops_men' },
  { code: 'SZI', slug: 'sudadera-con-cierre', name: 'Sudadera con cierre', category: 'unisex/sudaderas', brand: 'nan', gender: 'unisex', garment: 'sudadera', price: '46.90', material: '80 % algodón, 20 % poliéster', care: CARE_COTTON, description: 'Sudadera con cierre completo, capucha y bolsillos laterales.', colors: ['Azul marino', 'Negro', 'Rojo'], sizes: 'alpha', chart: 'tops_men' },
  { code: 'PON', slug: 'poncho-lana-otavalo', name: 'Poncho de lana', category: 'unisex/sudaderas', brand: 'tejidos-del-sur', gender: 'unisex', garment: 'abrigo', price: '68.00', material: '100 % lana de oveja', care: 'Lavar a mano en agua fría. Secar en plano a la sombra.', description: 'Poncho tejido en telar por artesanos de Otavalo, con flecos en los bordes.', colors: ['Terracota', 'Beige', 'Negro'], sizes: 'unique' },
  { code: 'GOR', slug: 'gorra-lona', name: 'Gorra de lona', category: 'unisex/accesorios', brand: 'nan', gender: 'unisex', garment: 'gorra', price: '15.90', material: '100 % algodón', care: 'Lavar a mano. No usar secadora.', description: 'Gorra de seis paneles con visera curva y cierre ajustable.', colors: ['Negro', 'Beige', 'Azul marino', 'Verde oliva'], sizes: 'unique' },
  { code: 'GLA', slug: 'gorro-alpaca', name: 'Gorro de alpaca', category: 'unisex/accesorios', brand: 'tejidos-del-sur', gender: 'unisex', garment: 'gorra', price: '22.00', material: '100 % alpaca', care: 'Lavar a mano en agua fría. Secar en plano.', description: 'Gorro tejido de alpaca con doblez. Abriga en el Cotopaxi y en la ciudad.', colors: ['Rojo', 'Beige', 'Negro'], sizes: 'unique' },
  { code: 'BUF', slug: 'bufanda-alpaca', name: 'Bufanda de alpaca', category: 'unisex/accesorios', brand: 'tejidos-del-sur', gender: 'unisex', garment: 'bufanda', price: '28.00', compareAt: '35.00', material: '100 % alpaca', care: 'Lavar a mano en agua fría. Secar en plano.', description: 'Bufanda larga de alpaca, suave y liviana, con flecos.', colors: ['Beige', 'Terracota', 'Azul marino', 'Rojo'], sizes: 'unique' },
];

const colorSlug = (name: string) => DEMO_COLORS.find((c) => c.name === name)!.slug;

/** Costo determinista entre el 38 % y el 53 % del precio: el margen de los reportes varía por producto. */
function demoCost(productIndex: number, price: string): string {
  return ((Number(price) * (38 + (productIndex % 6) * 3)) / 100).toFixed(2);
}

/** Peso de envío por prenda (g). */
const WEIGHT_G: Partial<Record<Garment, number>> = { chaqueta: 700, sudadera: 700, abrigo: 900, gorra: 150, bufanda: 200 };

/** Stock determinista: algunas tallas agotadas y otras con pocas unidades, para ver los estados. */
function demoStock(productIndex: number, colorIndex: number, sizeIndex: number): number {
  const n = (productIndex * 7 + colorIndex * 3 + sizeIndex * 5) % 11;
  if (n === 0) return 0;
  if (n <= 2) return n; // pocas unidades
  return 4 + n * 2;
}

export async function seedCatalog(db: Queryable, tenantId: string, warehouseId: string): Promise<{ products: number; variants: number }> {
  const id = async (sql: string, params: unknown[]) => (await db.query<{ id: string }>(sql, params)).rows[0].id;

  const brandIds: Record<string, string> = {};
  for (const [slug, name] of BRANDS) {
    brandIds[slug] = await id(
      `INSERT INTO catalog.brands (tenant_id, name, slug) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, slug) DO UPDATE SET name = EXCLUDED.name, active = true RETURNING id`,
      [tenantId, name, slug],
    );
  }
  const colorIds: Record<string, string> = {};
  for (const c of DEMO_COLORS) {
    colorIds[c.name] = await id(
      `INSERT INTO catalog.colors (tenant_id, name, hex, family) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, name) DO UPDATE SET hex = EXCLUDED.hex, family = EXCLUDED.family RETURNING id`,
      [tenantId, c.name, c.hex, c.family],
    );
  }
  const sizeIds: Record<string, string> = {};
  for (const [system, codes] of [
    ['alpha', ALPHA],
    ['numeric', NUMERIC],
  ] as const) {
    for (const [i, code] of codes.entries()) {
      sizeIds[`${system}:${code}`] = await id(
        `INSERT INTO catalog.sizes (tenant_id, code, size_system, sort_order) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, size_system, code) DO UPDATE SET sort_order = EXCLUDED.sort_order RETURNING id`,
        [tenantId, code, system, i],
      );
    }
  }
  sizeIds[`alpha:${UNIQUE}`] = await id(
    `INSERT INTO catalog.sizes (tenant_id, code, size_system, sort_order) VALUES ($1, $2, 'alpha', $3)
     ON CONFLICT (tenant_id, size_system, code) DO UPDATE SET sort_order = EXCLUDED.sort_order RETURNING id`,
    [tenantId, UNIQUE, ALPHA.length],
  );
  const chartIds: Record<string, string> = {};
  for (const [key, chart] of Object.entries(SIZE_CHARTS)) {
    // size_charts no tiene clave natural: se reutiliza la fila con el mismo nombre.
    const existing = await db.query<{ id: string }>(`SELECT id FROM catalog.size_charts WHERE tenant_id = $1 AND name = $2`, [tenantId, chart.name]);
    chartIds[key] = existing.rows[0]
      ? (await db.query(`UPDATE catalog.size_charts SET data = $2 WHERE id = $1`, [existing.rows[0].id, JSON.stringify(chart.data)]), existing.rows[0].id)
      : await id(`INSERT INTO catalog.size_charts (tenant_id, name, data) VALUES ($1, $2, $3) RETURNING id`, [tenantId, chart.name, JSON.stringify(chart.data)]);
  }
  const categoryIds: Record<string, string> = {};
  for (const [path, name, sort] of CATEGORIES) {
    const parent = path.includes('/') ? categoryIds[path.slice(0, path.lastIndexOf('/'))] : null;
    categoryIds[path] = await id(
      `INSERT INTO catalog.categories (tenant_id, parent_id, name, slug, path, sort_order) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, path) DO UPDATE SET name = EXCLUDED.name, parent_id = EXCLUDED.parent_id, sort_order = EXCLUDED.sort_order, active = true
       RETURNING id`,
      [tenantId, parent, name, path.split('/').pop(), path, sort],
    );
  }

  let variants = 0;
  for (const [pi, p] of DEMO_PRODUCTS.entries()) {
    const productId = await id(
      `INSERT INTO catalog.products (tenant_id, brand_id, category_id, size_chart_id, name, slug, description, gender, material,
                                     care_instructions, base_price, compare_at_price, cost, attributes, seo, status, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $16, $13, $14, 'active', now() - make_interval(hours => $15))
       ON CONFLICT (tenant_id, slug) DO UPDATE SET
         brand_id = EXCLUDED.brand_id, category_id = EXCLUDED.category_id, size_chart_id = EXCLUDED.size_chart_id, name = EXCLUDED.name,
         description = EXCLUDED.description, gender = EXCLUDED.gender, material = EXCLUDED.material, care_instructions = EXCLUDED.care_instructions,
         base_price = EXCLUDED.base_price, compare_at_price = EXCLUDED.compare_at_price, cost = EXCLUDED.cost, attributes = EXCLUDED.attributes, seo = EXCLUDED.seo,
         status = 'active', updated_at = now()
       RETURNING id`,
      [
        tenantId,
        brandIds[p.brand],
        categoryIds[p.category],
        p.chart ? chartIds[p.chart] : null,
        p.name,
        p.slug,
        p.description,
        p.gender,
        p.material,
        p.care,
        p.price,
        p.compareAt ?? null,
        JSON.stringify(p.fit ? { fit: p.fit } : {}),
        JSON.stringify({ title: `${p.name} | Moda Demo`, description: p.description.slice(0, 155) }),
        // Uno por hora hacia atrás: "novedades" tiene un orden estable.
        pi,
        demoCost(pi, p.price),
      ],
    );

    await db.query(`DELETE FROM catalog.product_media WHERE product_id = $1`, [productId]);
    const sizes = p.sizes === 'unique' ? [UNIQUE] : p.sizes === 'alpha' ? ALPHA : NUMERIC;
    const system = p.sizes === 'numeric' ? 'numeric' : 'alpha';
    for (const [ci, color] of p.colors.entries()) {
      const key = `demo/${p.garment}-${colorSlug(color)}`;
      await db.query(
        `INSERT INTO catalog.product_media (product_id, color_id, media_type, storage_key, alt_text, width, height, sort_order)
         VALUES ($1, $2, 'image', $3, $4, 800, 1000, $5), ($1, $2, 'image', $6, $7, 800, 1000, $8)`,
        [productId, colorIds[color], `${key}.svg`, `${p.name} color ${color.toLowerCase()}`, ci * 2, `${key}-detalle.svg`, `Detalle de ${p.name.toLowerCase()} ${color.toLowerCase()}`, ci * 2 + 1],
      );
      for (const [si, size] of sizes.entries()) {
        const sku = `DEMO-${p.code}-${colorSlug(color).toUpperCase()}-${size === UNIQUE ? 'U' : size}`;
        const variantId = await id(
          `INSERT INTO catalog.product_variants (product_id, sku, color_id, size_id, weight_g, length_mm, width_mm, height_mm)
           VALUES ($1, $2, $3, $4, $5, 300, 250, 40)
           ON CONFLICT (sku) DO UPDATE SET color_id = EXCLUDED.color_id, size_id = EXCLUDED.size_id, status = 'active' RETURNING id`,
          [productId, sku, colorIds[color], sizeIds[`${system}:${size}`], WEIGHT_G[p.garment] ?? 350],
        );
        await db.query(
          `INSERT INTO inventory.stock_levels (variant_id, warehouse_id, on_hand, reserved, reorder_point)
           VALUES ($1, $2, $3, 0, 3)
           ON CONFLICT (variant_id, warehouse_id) DO NOTHING`,
          [variantId, warehouseId, demoStock(pi, ci, si)],
        );
        variants++;
      }
    }
  }

  // La camiseta del seed original (pedidos de ejemplo) pasa a tener marca, color, tallas y foto.
  await db.query(
    `UPDATE catalog.products SET brand_id = $2, size_chart_id = $3, description = 'Camiseta básica de algodón peinado.', published_at = COALESCE(published_at, now() - interval '30 days')
      WHERE tenant_id = $1 AND slug = 'camiseta-basica'`,
    [tenantId, brandIds['andina-studio'], chartIds.tops_men],
  );
  for (const size of ['S', 'M', 'L']) {
    await db.query(`UPDATE catalog.product_variants SET color_id = $2, size_id = $3 WHERE sku = $1`, [`DEMO-CAM-${size}`, colorIds.Blanco, sizeIds[`alpha:${size}`]]);
  }
  await db.query(
    `INSERT INTO catalog.product_media (product_id, color_id, media_type, storage_key, alt_text, width, height, sort_order)
     SELECT p.id, $2, 'image', 'demo/camiseta-blanco.svg', 'Camiseta básica blanca', 800, 1000, 0 FROM catalog.products p
      WHERE p.tenant_id = $1 AND p.slug = 'camiseta-basica'
        AND NOT EXISTS (SELECT 1 FROM catalog.product_media m WHERE m.product_id = p.id)`,
    [tenantId, colorIds.Blanco],
  );

  return { products: DEMO_PRODUCTS.length, variants };
}
