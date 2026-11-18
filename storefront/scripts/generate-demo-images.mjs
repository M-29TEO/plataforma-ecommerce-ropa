// Genera las ilustraciones del catálogo de demo (public/media/demo/<prenda>-<color>[-detalle].svg).
// Sin fotos de terceros: siluetas vectoriales propias con sombreado y costuras. Las claves coinciden
// con backend/scripts/seed-catalog.ts (product_media.storage_key = 'demo/<prenda>-<color>.svg').
//
//   npm run images:demo
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'media', 'demo');
mkdirSync(out, { recursive: true });

const COLORS = [
  ['negro', '#1C1C1E'],
  ['blanco', '#F4F1EA'],
  ['beige', '#D8C3A5'],
  ['azul-marino', '#22315A'],
  ['celeste', '#8DB8DE'],
  ['rojo', '#B3262E'],
  ['verde-oliva', '#5E6B3A'],
  ['terracota', '#C0643F'],
];

/** Silueta (viewBox 800×1000) y detalles (costuras, botones, bolsillos) de cada prenda. */
const GARMENTS = {
  camiseta: {
    body: 'M262 222 L342 182 Q400 222 458 182 L538 222 L640 322 L576 388 L536 348 L536 806 L264 806 L264 348 L224 388 L160 322 Z',
    details: '<path d="M342 182 Q400 236 458 182" class="st"/><path d="M264 790 L536 790" class="st"/><path d="M224 372 L264 332 M576 372 L536 332" class="st"/>',
  },
  camisa: {
    body: 'M268 212 L350 176 L400 222 L450 176 L532 212 L604 304 L644 646 L588 656 L548 366 L548 826 L252 826 L252 366 L212 656 L156 646 L196 304 Z',
    details:
      '<path d="M350 176 L388 262 L400 222 L412 262 L450 176" class="st"/><path d="M400 262 L400 820" class="st"/>' +
      [300, 380, 460, 540, 620, 700, 780].map((y) => `<circle cx="400" cy="${y}" r="7" class="btn"/>`).join('') +
      '<path d="M290 420 h70 v70 h-70 Z" class="st"/><path d="M212 640 L156 630 M588 640 L644 630" class="st"/>',
  },
  blusa: {
    body: 'M286 222 Q340 190 362 186 Q400 236 438 186 Q460 190 514 222 L602 332 L556 374 L520 334 Q532 566 562 786 L238 786 Q268 566 280 334 L244 374 L198 332 Z',
    details: '<path d="M362 186 Q400 250 438 186" class="st"/><path d="M400 250 L400 330" class="st"/><path d="M246 770 Q400 790 554 770" class="st"/>',
  },
  vestido: {
    body: 'M330 168 L370 168 Q400 206 430 168 L470 168 L502 262 Q484 334 472 404 Q562 606 612 884 L188 884 Q238 606 328 404 Q316 334 298 262 Z',
    details: '<path d="M328 404 Q400 420 472 404 M322 430 Q400 446 478 430" class="st"/><path d="M370 168 Q400 230 430 168" class="st"/><path d="M196 866 Q400 900 604 866" class="st"/>',
  },
  falda: {
    body: 'M298 252 L502 252 L522 306 Q604 604 642 846 L158 846 Q198 604 278 306 Z',
    details: '<path d="M282 300 L518 300" class="st"/>' + [-150, -90, -30, 30, 90, 150].map((dx) => `<path d="M${400 + dx * 0.35} 306 L${400 + dx * 1.45} 838" class="st"/>`).join(''),
  },
  jean: {
    body: 'M288 150 L512 150 L542 884 L432 884 L400 336 L368 884 L258 884 Z',
    details:
      '<path d="M290 196 L510 196" class="st"/><path d="M400 196 L400 336" class="st"/>' +
      '<path d="M300 210 Q330 270 380 240 M500 210 Q470 270 420 240" class="st"/>' +
      '<path d="M266 866 L366 866 M434 866 L534 866" class="st"/><rect x="384" y="160" width="32" height="26" rx="4" class="btn"/>',
  },
  chaqueta: {
    body: 'M262 206 L346 172 L400 214 L454 172 L538 206 L612 300 L652 690 L594 700 L556 380 L556 846 L244 846 L244 380 L206 700 L148 690 L188 300 Z',
    details:
      '<path d="M346 172 L372 330 L400 214 L428 330 L454 172" class="st"/><path d="M400 330 L400 840" class="st"/>' +
      '<path d="M272 470 h88 v96 h-88 Z M440 470 h88 v96 h-88 Z" class="st"/>' +
      [400, 500, 600, 700].map((y) => `<circle cx="384" cy="${y}" r="8" class="btn"/>`).join('') +
      '<path d="M206 684 L148 674 M594 684 L652 674 M244 826 L556 826" class="st"/>',
  },
  sudadera: {
    body: 'M272 236 L330 200 Q400 238 470 200 L528 236 L612 330 L648 684 L590 694 L556 392 L556 832 L244 832 L244 392 L210 694 L152 684 L188 330 Z',
    details:
      '<path d="M330 200 Q300 120 400 104 Q500 120 470 200 Q400 250 330 200 Z" class="hood"/>' +
      '<path d="M380 238 L372 330 M420 238 L428 330" class="st"/><path d="M306 600 L494 600 L520 720 L280 720 Z" class="st"/>' +
      '<path d="M244 806 L556 806 M210 676 L152 666 M590 676 L648 666" class="st"/>',
  },
  pantalon: {
    body: 'M290 150 L510 150 L548 884 L438 884 L400 360 L362 884 L252 884 Z',
    details:
      '<path d="M292 196 L508 196" class="st"/><path d="M400 196 L400 340" class="st"/>' +
      '<path d="M304 210 L344 300 M496 210 L456 300" class="st"/><path d="M322 400 L306 868 M478 400 L494 868" class="st"/>' +
      '<path d="M260 866 L360 866 M440 866 L540 866" class="st"/><rect x="388" y="162" width="24" height="24" rx="12" class="btn"/>',
  },
  short: {
    body: 'M280 300 L520 300 L556 640 L424 662 L400 470 L376 662 L244 640 Z',
    details:
      '<path d="M282 344 L518 344" class="st"/><path d="M400 344 L400 460" class="st"/>' +
      '<path d="M298 360 Q320 420 370 392 M502 360 Q480 420 430 392" class="st"/>' +
      '<path d="M252 620 L374 640 M426 640 L548 620" class="st"/>',
  },
  abrigo: {
    body: 'M258 196 L344 160 L400 206 L456 160 L542 196 L616 296 L656 720 L598 730 L560 382 L572 920 L228 920 L240 382 L202 730 L144 720 L184 296 Z',
    details:
      '<path d="M344 160 L380 360 L400 206 L420 360 L456 160" class="st"/><path d="M400 360 L400 914" class="st"/>' +
      '<path d="M240 560 L560 560 M238 588 L562 588" class="st"/>' +
      [420, 500, 660].map((y) => `<circle cx="372" cy="${y}" r="8" class="btn"/><circle cx="428" cy="${y}" r="8" class="btn"/>`).join('') +
      '<path d="M262 650 h86 M452 650 h86" class="st"/><path d="M202 714 L144 704 M598 714 L656 704 M232 900 L568 900" class="st"/>',
  },
  gorra: {
    body: 'M220 610 Q222 332 400 316 Q578 332 580 560 Q664 574 704 612 Q644 652 560 630 Z',
    details:
      '<path d="M400 320 L400 600" class="st"/><path d="M306 344 Q292 470 296 604 M494 344 Q508 470 506 600" class="st"/>' +
      '<path d="M580 562 Q600 600 566 628" class="st"/><path d="M232 590 L566 604" class="st"/><circle cx="400" cy="318" r="11" class="btn"/>',
  },
  bufanda: {
    body: 'M296 170 L504 170 L522 300 L474 860 L378 860 L414 334 L346 334 L334 760 L246 760 Z',
    details:
      '<path d="M300 214 L508 214 M306 262 L514 262" class="st"/><path d="M402 400 L462 400 M398 470 L456 470" class="st"/>' +
      [384, 400, 416, 432, 448, 464].map((x) => `<path d="M${x} 862 L${x} 910" class="st"/>`).join('') +
      [252, 268, 284, 300, 316].map((x) => `<path d="M${x} 762 L${x} 808" class="st"/>`).join(''),
  },
};

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function svg(garment, hex, detail) {
  const g = GARMENTS[garment];
  const light = luminance(hex) > 0.6;
  const stitch = light ? 'rgba(60,50,40,.35)' : 'rgba(255,255,255,.28)';
  // Detalle: acercamiento a la parte central con textura de tejido.
  const viewBox = detail ? '220 260 360 450' : '0 0 800 1000';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="800" height="1000" preserveAspectRatio="xMidYMid slice" role="img">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F6F2EC"/><stop offset="1" stop-color="#E9E2D8"/></linearGradient>
  <linearGradient id="shade" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#000" stop-opacity=".16"/><stop offset=".35" stop-color="#fff" stop-opacity=".10"/>
    <stop offset=".65" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".18"/>
  </linearGradient>
  <pattern id="weave" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
    <path d="M0 0 L0 8" stroke="${light ? '#000' : '#fff'}" stroke-opacity=".07" stroke-width="3"/>
  </pattern>
  <style>.st{fill:none;stroke:${stitch};stroke-width:3;stroke-dasharray:9 7;stroke-linecap:round}.btn{fill:${light ? '#8a7f70' : '#d9d2c5'};opacity:.85}.hood{fill:${hex};stroke:rgba(0,0,0,.18);stroke-width:2}</style>
</defs>
<rect x="0" y="0" width="800" height="1000" fill="url(#bg)"/>
<ellipse cx="400" cy="930" rx="250" ry="22" fill="#000" opacity=".07"/>
<g>
  <path d="${g.body}" fill="${hex}" stroke="rgba(0,0,0,.18)" stroke-width="2"/>
  <path d="${g.body}" fill="url(#shade)"/>
  ${detail ? `<path d="${g.body}" fill="url(#weave)"/>` : ''}
  ${g.details}
</g>
</svg>
`;
}

let count = 0;
for (const garment of Object.keys(GARMENTS)) {
  for (const [slug, hex] of COLORS) {
    writeFileSync(join(out, `${garment}-${slug}.svg`), svg(garment, hex, false));
    writeFileSync(join(out, `${garment}-${slug}-detalle.svg`), svg(garment, hex, true));
    count += 2;
  }
}
console.log(`${count} ilustraciones en ${out}`);
