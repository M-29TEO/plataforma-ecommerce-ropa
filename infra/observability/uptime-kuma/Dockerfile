# Servicio de un solo uso: configura Uptime Kuma y termina (docker-compose.yml, kuma-setup).
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY setup.mjs ./
USER node
CMD ["node", "setup.mjs"]
