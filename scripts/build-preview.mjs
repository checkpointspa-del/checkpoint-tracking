#!/usr/bin/env node
/**
 * Genera preview/anteprima.html dal template Liquid reale.
 *
 * Non è una copia: estrae CSS e JS dal file che finirà nel tema e li esegue
 * con dati finti. Se la pagina cambia, l'anteprima cambia con lei.
 *
 *   node scripts/build-preview.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(dir, '../shopify/page.tracking-area.liquid'), 'utf8');

const css = src.match(/<style>([\s\S]*?)<\/style>/)[1];
const js = src.match(/\{%\s*raw\s*%\}\s*<script>([\s\S]*?)<\/script>\s*\{%\s*endraw\s*%\}/)[1];

const P = (status, phase, step, tone, title, sub, pill, number, url) => ({
  status, phase, step, tone, title, sub, pill,
  number, carrier: number ? 'Poste Italiane' : null,
  carrierUrl: phase === 2 ? url : null, happenedAt: null,
});

const T = 'https://www.poste.it/cerca/index.html#/risultati-spedizioni/CODICE';

const SCENARIOS = {
  'Fase 1 · con data':      { order: '26CKPT0001', allDelivered: false, eta: '25 agosto', parcels: [P('NONE', 1, 0, 'idle', 'Ordine in lavorazione', 'Stiamo preparando il tuo pacco.', 'In preparazione', null)] },
  'Fase 1 · senza data':    { order: '26CKPT0001', allDelivered: false, eta: null,        parcels: [P('NONE', 1, 0, 'idle', 'Ordine in lavorazione', 'Stiamo preparando il tuo pacco.', 'In preparazione', null)] },
  'In viaggio':             { order: '26CKPT0001', allDelivered: false, eta: null,        parcels: [P('IN_TRANSIT', 2, 1, 'live', 'Spedizione in viaggio', 'Il pacco è in transito verso di te.', 'In viaggio', 'AAA0000000001', T)] },
  'In consegna':            { order: '26CKPT0001', allDelivered: false, eta: null,        parcels: [P('OUT_FOR_DELIVERY', 2, 2, 'live', 'In consegna oggi', 'Il pacco è sul mezzo del corriere.', 'In consegna', 'AAA0000000001', T)] },
  'Eccezione':              { order: '26CKPT0001', allDelivered: false, eta: null,        parcels: [P('DELAYED', 2, 1, 'warn', 'Spedizione in ritardo', 'Il corriere segnala un ritardo. Il pacco è comunque in viaggio.', 'In ritardo', 'AAA0000000001', T)] },
  'Consegnato':             { order: '26CKPT0001', allDelivered: true,  eta: null,        parcels: [P('DELIVERED', 3, 3, 'done', 'Ordine consegnato', '', 'Consegnato', 'AAA0000000001', null)] },
  '2 spedizioni · miste':   { order: '26CKPT0002', allDelivered: false, eta: null,        parcels: [P('DELIVERED', 3, 3, 'done', 'Spedizione consegnata', '', 'Consegnato', 'AAA0000000001', null), P('IN_TRANSIT', 2, 1, 'live', 'Spedizione in viaggio', 'Il pacco è in transito verso di te.', 'In viaggio', 'AAA0000000002', T)] },
  '2 spedizioni · complete':{ order: '26CKPT0002', allDelivered: true,  eta: null,        parcels: [P('DELIVERED', 3, 3, 'done', 'Spedizione consegnata', '', 'Consegnato', 'AAA0000000001', null), P('DELIVERED', 3, 3, 'done', 'Spedizione consegnata', '', 'Consegnato', 'AAA0000000002', null)] },
  'Link non valido':        null,
};

const html = `<!doctype html>
<html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Anteprima pagina tracking — Check Point</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..700&family=Instrument+Sans:wght@400..600&display=swap">
<style>
  body{margin:0;background:#F1F3F6;font-family:"Instrument Sans","Helvetica Neue",Arial,sans-serif;color:#0C0E12;padding-bottom:78px}
  .bar{position:fixed;left:0;right:0;bottom:0;background:#15181F;border-top:1px solid #2A2F3A;padding:11px 16px;display:flex;gap:7px;flex-wrap:wrap;justify-content:center;z-index:50}
  .bar b{color:#8B93A3;font-size:10px;letter-spacing:.15em;text-transform:uppercase;align-self:center;margin-right:6px;font-weight:600}
  .bar button{background:transparent;border:1px solid #2A2F3A;color:#8B93A3;border-radius:999px;padding:5px 11px;font:inherit;font-size:12.5px;cursor:pointer}
  .bar button[aria-pressed=true]{background:#E8EBF1;border-color:#E8EBF1;color:#15181F;font-weight:600}
${css}
</style></head>
<body>
<div class="cp-wrap">
  <div id="cp-root" data-api="mock"><div class="cp-card cp-skeleton"><div class="cp-body"><p class="cp-loading">Caricamento…</p></div></div></div>
</div>
<nav class="bar" id="bar"><b>Anteprima</b></nav>
<script>
const MOCK = ${JSON.stringify(SCENARIOS, null, 2)};
let current = Object.keys(MOCK)[0];
const RENDER = ${JSON.stringify(js)};

window.fetch = (url) => Promise.resolve({
  ok: MOCK[current] !== null,
  status: MOCK[current] === null ? 404 : 200,
  json: () => Promise.resolve(MOCK[current]),
});

function run(){
  const q = MOCK[current] === null ? '' : '?o=1&t=1';
  history.replaceState(null, '', location.pathname + q);
  document.getElementById('cp-root').innerHTML =
    '<div class="cp-card cp-skeleton"><div class="cp-body"><p class="cp-loading">Caricamento…</p></div></div>';
  new Function(RENDER)();
}

const bar = document.getElementById('bar');
Object.keys(MOCK).forEach((name, i) => {
  const b = document.createElement('button');
  b.textContent = name;
  b.setAttribute('aria-pressed', i === 0 ? 'true' : 'false');
  b.onclick = () => {
    bar.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed','false'));
    b.setAttribute('aria-pressed','true');
    current = name;
    run();
  };
  bar.appendChild(b);
});
run();
</script>
</body></html>`;

const out = path.join(dir, '../preview/anteprima.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log('Anteprima generata:', out);
