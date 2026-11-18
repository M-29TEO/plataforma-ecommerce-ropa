import Image from 'next/image';

/**
 * Foto de producto con proporción 4:5. Las ilustraciones SVG de la demo se sirven tal cual
 * (Next no optimiza SVG); las fotos raster pasan por el optimizador de imágenes.
 */
export function ProductImage({
  src,
  alt,
  sizes = '(min-width: 1024px) 25vw, (min-width: 640px) 33vw, 50vw',
  preload = false,
  className = '',
}: {
  src: string | null | undefined;
  alt: string;
  sizes?: string;
  preload?: boolean;
  className?: string;
}) {
  if (!src) return <div className={`aspect-[4/5] w-full bg-sand ${className}`} aria-hidden />;
  const svg = src.endsWith('.svg');
  return (
    <Image
      src={src}
      alt={alt}
      width={800}
      height={1000}
      sizes={sizes}
      // El <link rel=preload> de un SVG sin optimizar no coincide con la <img> (Chrome avisaba "not
      // used" y lo bajaba dos veces): a esos se les da prioridad alta en la propia <img>.
      preload={preload && !svg}
      loading={preload ? 'eager' : undefined}
      fetchPriority={preload && svg ? 'high' : undefined}
      unoptimized={svg}
      className={`aspect-[4/5] w-full object-cover ${className}`}
    />
  );
}
