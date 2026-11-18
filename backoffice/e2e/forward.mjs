// Dentro del contenedor de Playwright: reenvía localhost:<puerto> → host.docker.internal:<puerto>.
// Así el navegador abre la tienda como http://localhost (contexto seguro: service worker y GPS
// funcionan) aunque el storefront, la API y la pasarela corran en el equipo anfitrión.
//
//   node e2e/forward.mjs 3100 3998 8081 & npx playwright test
import net from 'node:net';

const target = process.env.FORWARD_HOST || 'host.docker.internal';
for (const port of process.argv.slice(2).map(Number)) {
  net
    .createServer((client) => {
      const upstream = net.connect(port, target);
      client.pipe(upstream).pipe(client);
      const close = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on('error', close);
      upstream.on('error', close);
    })
    .listen(port, '127.0.0.1', () => console.log(`localhost:${port} → ${target}:${port}`));
}
