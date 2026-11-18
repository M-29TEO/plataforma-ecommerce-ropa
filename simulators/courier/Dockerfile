# Courier simulado: Node puro, sin dependencias.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY package.json server.mjs tariffs.mjs label-pdf.mjs ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "server.mjs"]
