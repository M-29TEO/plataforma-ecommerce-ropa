/**
 * Genera un par de claves VAPID para Web Push (npm run vapid:keys). Solo imprime: copia las líneas
 * a backend/.env (o al .env de la raíz para docker compose). La clave privada no se sube al repo.
 */
import webpush from 'web-push';

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log('# Web Push (VAPID) — pega esto en tu .env');
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log('VAPID_SUBJECT=mailto:soporte@moda-demo.test');
