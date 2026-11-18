/** "Pichincha", " PICHINCHA", "Galápagos" → "pichincha", "galapagos" (para comparar nombres). */
export function normalizePlace(value: string | null | undefined): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

/**
 * Provincia de las ciudades más comunes, para cuando la dirección (o la bodega) no la trae.
 * Los couriers cotizan por provincia de destino; sin geocodificación inversa (Nominatim llega
 * después), esta tabla cubre las cabeceras provinciales y las parroquias de Quito y Guayaquil.
 */
const PROVINCE_OF_CITY: Record<string, string> = {
  quito: 'Pichincha',
  cumbaya: 'Pichincha',
  tumbaco: 'Pichincha',
  conocoto: 'Pichincha',
  sangolqui: 'Pichincha',
  cayambe: 'Pichincha',
  guayaquil: 'Guayas',
  samborondon: 'Guayas',
  duran: 'Guayas',
  cuenca: 'Azuay',
  ambato: 'Tungurahua',
  riobamba: 'Chimborazo',
  latacunga: 'Cotopaxi',
  ibarra: 'Imbabura',
  otavalo: 'Imbabura',
  tulcan: 'Carchi',
  loja: 'Loja',
  machala: 'El Oro',
  portoviejo: 'Manabí',
  manta: 'Manabí',
  esmeraldas: 'Esmeraldas',
  'santo domingo': 'Santo Domingo de los Tsáchilas',
  babahoyo: 'Los Ríos',
  quevedo: 'Los Ríos',
  'santa elena': 'Santa Elena',
  salinas: 'Santa Elena',
  guaranda: 'Bolívar',
  azogues: 'Cañar',
  tena: 'Napo',
  puyo: 'Pastaza',
  macas: 'Morona Santiago',
  zamora: 'Zamora Chinchipe',
  'nueva loja': 'Sucumbíos',
  coca: 'Orellana',
  'puerto francisco de orellana': 'Orellana',
  'puerto ayora': 'Galápagos',
  'puerto baquerizo moreno': 'Galápagos',
};

/** Provincia indicada o, si falta, la de la tabla. null si no se puede saber. */
export function provinceFor(city: string | null | undefined, province?: string | null): string | null {
  if (province && province.trim()) return province.trim();
  return PROVINCE_OF_CITY[normalizePlace(city)] ?? null;
}
