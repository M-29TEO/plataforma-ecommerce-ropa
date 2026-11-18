# Storefront (Next.js, salida standalone). Las variables NEXT_PUBLIC_* se fijan al construir
# (Next las incrusta en el JS del navegador); las del servidor (API_INTERNAL_URL, STORE_TENANT_ID)
# se pasan al arrancar. La imagen se construye sin la API disponible: catálogo y fichas se generan
# en la primera visita (ISR) y la home se renderiza por petición.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

FROM node:24-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ARG NEXT_PUBLIC_SITE_URL=http://localhost
ARG NEXT_PUBLIC_STORE_NAME="Moda Demo"
ARG NEXT_PUBLIC_API_URL=/api
ARG NEXT_PUBLIC_MAP_TILES=osm
ARG NEXT_PUBLIC_PMTILES_URL=/tiles/ecuador.pmtiles
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_STORE_NAME=$NEXT_PUBLIC_STORE_NAME \
    NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_MAP_TILES=$NEXT_PUBLIC_MAP_TILES \
    NEXT_PUBLIC_PMTILES_URL=$NEXT_PUBLIC_PMTILES_URL
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN node scripts/copy-maplibre-worker.mjs && npx next build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/robots.txt >/dev/null || exit 1
CMD ["node", "server.js"]
