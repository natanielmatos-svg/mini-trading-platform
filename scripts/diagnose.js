#!/usr/bin/env node
'use strict';

// Diagnóstico de campo: se ejecuta donde SÍ hay red y describe qué está
// devolviendo cada API ahora mismo, para poder arreglar el parser sin adivinar.
//
//   npm run diagnose
//
// No imprime las respuestas enteras (son enormes), sino su forma: qué claves
// traen, cuántos elementos, y qué valores toman los campos de los que depende
// el parser. Al final compara títulos entre plataformas para ver por qué no se
// están emparejando los eventos.

const { fetchJson } = require('../src/http');
const providers = require('../src/providers');
const { eventSimilarity } = require('../src/match');

const KALSHI_BASE = process.env.KALSHI_API || 'https://api.elections.kalshi.com/trade-api/v2';

const keys = (obj) => (obj && typeof obj === 'object' ? Object.keys(obj).join(', ') : String(obj));
const trunc = (t, n = 70) => {
  const s = String(t ?? '').replace(/\s+/g, ' ');
  return s.length > n ? s.slice(0, n) + '…' : s;
};

function line(char = '-') {
  console.log(char.repeat(72));
}

async function probe(label, url, params) {
  try {
    const data = await fetchJson(url, { searchParams: params, timeoutMs: 20000, retries: 1 });
    console.log(`  ${label}: OK`);
    return data;
  } catch (err) {
    console.log(`  ${label}: FALLO — ${trunc(err.message, 110)}`);
    return null;
  }
}

async function diagnoseKalshi() {
  line('=');
  console.log('KALSHI — por qué no sale ningún evento utilizable');
  line('=');

  // 1. El endpoint de eventos tal y como lo pide el proveedor hoy.
  const ev = await probe('GET /events (con_nested_markets)', `${KALSHI_BASE}/events`, {
    status: 'open',
    limit: 10,
    with_nested_markets: 'true',
  });

  if (ev) {
    console.log(`  claves de la respuesta: ${keys(ev)}`);
    const list = Array.isArray(ev.events) ? ev.events : null;

    if (!list) {
      console.log('  >> NO hay un array "events" en la respuesta. Ahí está el fallo.');
    } else {
      console.log(`  eventos recibidos: ${list.length}`);
      const first = list[0];
      if (first) {
        console.log(`  claves de un evento: ${keys(first)}`);
        console.log(`  title: ${trunc(first.title)}`);
        console.log(`  mutually_exclusive: ${first.mutually_exclusive}`);

        const markets = first.markets;
        if (!Array.isArray(markets)) {
          console.log(`  >> el evento NO trae "markets" (valor: ${markets}).`);
          console.log('     with_nested_markets ya no se aplica, o cambió de nombre.');
        } else {
          console.log(`  markets anidados: ${markets.length}`);
          if (markets[0]) {
            const m = markets[0];
            console.log(`  claves de un market: ${keys(m)}`);
            console.log(`  status="${m.status}" yes_sub_title="${trunc(m.yes_sub_title, 40)}" close_time=${m.close_time}`);

            // Valores crudos de los campos de los que depende el parser, con su
            // tipo: "fp" es punto fijo y podría venir escalado, lo que desviaría
            // el peso de esta plataforma en el consenso.
            console.log('  valores crudos:');
            for (const campo of [
              'yes_bid_dollars', 'yes_ask_dollars', 'no_bid_dollars', 'no_ask_dollars',
              'last_price_dollars', 'liquidity_dollars', 'volume_fp', 'volume_24h_fp',
              'open_interest_fp', 'yes_bid', 'yes_ask', 'volume', 'liquidity',
            ]) {
              if (m[campo] !== undefined) {
                console.log(`    ${campo} = ${JSON.stringify(m[campo])}  (${typeof m[campo]})`);
              }
            }
          }
          // El parser descarta todo lo que no esté en active/open: si los
          // valores reales son otros, ahí se pierden los eventos.
          const estados = new Set();
          for (const e of list) for (const m of e.markets || []) estados.add(m.status);
          console.log(`  >> valores de status vistos: ${[...estados].join(', ') || 'ninguno'}`);

          // Y lo que importa: cuántos sobreviven al parser actual.
          const kalshi = require('../src/providers/kalshi');
          const parseados = list.map(kalshi.mapEvent).filter(Boolean);
          console.log(`  >> eventos que sobreviven al parser: ${parseados.length} de ${list.length}`);
          if (parseados[0]) {
            const o = parseados[0].options[0];
            console.log(`     ejemplo: "${trunc(parseados[0].title, 45)}" → "${trunc(o.label, 25)}" a ${(o.price * 100).toFixed(1)}¢`);
          }
        }
      }
    }
  }

  // 2. Alternativa: el endpoint de mercados planos, por si hay que cambiar de
  //    estrategia y agrupar por event_ticker nosotros.
  const mk = await probe('GET /markets (plano)', `${KALSHI_BASE}/markets`, {
    status: 'open',
    limit: 5,
  });

  if (mk) {
    console.log(`  claves de la respuesta: ${keys(mk)}`);
    const list = Array.isArray(mk.markets) ? mk.markets : [];
    console.log(`  markets recibidos: ${list.length}`);
    if (list[0]) {
      console.log(`  claves de un market: ${keys(list[0])}`);
      const m = list[0];
      console.log(`  ticker=${m.ticker} event_ticker=${m.event_ticker} status="${m.status}"`);
      console.log(`  yes_bid=${m.yes_bid} yes_ask=${m.yes_ask} yes_sub_title="${trunc(m.yes_sub_title, 40)}"`);
    }
  }
}

async function diagnoseMatching() {
  line('=');
  console.log('EMPAREJAMIENTO — por qué no coincide nada entre plataformas');
  line('=');

  const { events, sources } = await providers.fetchAll({ limit: 100, timeoutMs: 20000 });
  for (const s of sources) {
    console.log(`  ${s.platformLabel}: ${s.ok ? `${s.events} eventos` : `FALLO ${trunc(s.error, 60)}`}`);
  }

  const porPlataforma = new Map();
  for (const e of events) {
    if (!porPlataforma.has(e.platform)) porPlataforma.set(e.platform, []);
    porPlataforma.get(e.platform).push(e);
  }

  const plataformas = [...porPlataforma.keys()];
  if (plataformas.length < 2) {
    console.log('\n  Sólo hay una plataforma con datos: no hay nada que emparejar.');
    return;
  }

  // Para cada par de plataformas, las mejores parejas por similitud. Si las
  // puntuaciones altas corresponden a eventos que de verdad son el mismo, el
  // problema es el umbral; si no llegan ni a parecerse, es que no hay solape.
  for (let i = 0; i < plataformas.length; i++) {
    for (let j = i + 1; j < plataformas.length; j++) {
      const a = porPlataforma.get(plataformas[i]);
      const b = porPlataforma.get(plataformas[j]);
      const pares = [];

      for (const ea of a) {
        for (const eb of b) {
          pares.push({ score: eventSimilarity(ea, eb), ea, eb });
        }
      }
      pares.sort((x, y) => y.score - x.score);

      line();
      console.log(`${plataformas[i]} (${a.length}) vs ${plataformas[j]} (${b.length}) — umbral actual: 0.50`);
      for (const p of pares.slice(0, 8)) {
        console.log(`  ${p.score.toFixed(3)}  ${trunc(p.ea.title, 46)}`);
        console.log(`         ${trunc(p.eb.title, 46)}`);
      }
      const superan = pares.filter((p) => p.score >= 0.5).length;
      console.log(`  parejas por encima del umbral: ${superan}`);
    }
  }
}

async function main() {
  await diagnoseKalshi();
  console.log();
  await diagnoseMatching();
  console.log('\nPega esta salida entera en la conversación.');
}

main().catch((err) => {
  console.error('El diagnóstico no pudo completarse:', err.message);
  process.exit(1);
});
