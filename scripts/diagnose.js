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
          // Misma regla de fechas que usa el agrupador: 30 días de margen, y
          // sin fecha en algún lado no se descarta nada.
          const fechasOk =
            !ea.closesAt || !eb.closesAt
              ? true
              : Math.abs(new Date(ea.closesAt) - new Date(eb.closesAt)) <= 365 * 24 * 3600 * 1000;
          pares.push({ score: eventSimilarity(ea, eb), fechasOk, ea, eb });
        }
      }
      pares.sort((x, y) => y.score - x.score);

      line();
      console.log(`${plataformas[i]} (${a.length}) vs ${plataformas[j]} (${b.length}) — umbral actual: 0.50`);
      for (const p of pares.slice(0, 8)) {
        const marca = p.score >= 0.5 ? (p.fechasOk ? '✓ agrupa' : '· fecha lo frena') : '  ';
        console.log(`  ${p.score.toFixed(3)} ${marca}  ${trunc(p.ea.title, 44)}`);
        console.log(`                ${trunc(p.eb.title, 44)}`);
      }
      // El agrupamiento real exige además que las fechas de cierre sean
      // compatibles, así que la similitud por sí sola sobreestima lo que se
      // acabaría fusionando.
      const superan = pares.filter((p) => p.score >= 0.5).length;
      const agrupan = pares.filter((p) => p.score >= 0.5 && p.fechasOk).length;
      console.log(`  parejas por encima del umbral: ${superan} (de las que se agruparían: ${agrupan})`);
    }
  }
}

async function diagnosePonderacion() {
  line('=');
  console.log('PONDERACIÓN — de dónde sale cada número del consenso');
  line('=');

  const { clusterEvents, canonicalizeOptions } = require('../src/match');
  const { quoteWeight } = require('../src/analyze');

  const { events } = await providers.fetchAll({ limit: 100, timeoutMs: 20000 });

  // Primero: ¿está leyendo cada proveedor la liquidez y el volumen? Si salen a
  // cero, el peso de esa plataforma colapsa al mínimo y el dinero de juego
  // acaba mandando sobre el dinero real sin que nada falle a la vista.
  const porPlataforma = new Map();
  for (const e of events) {
    if (!porPlataforma.has(e.platform)) porPlataforma.set(e.platform, []);
    porPlataforma.get(e.platform).push(e);
  }

  console.log('\nProfundidad declarada por plataforma (mediana entre sus eventos):');
  for (const [plataforma, lista] of porPlataforma) {
    const mediana = (campo) => {
      const vals = lista.map((e) => e[campo] || 0).sort((a, b) => a - b);
      return vals[Math.floor(vals.length / 2)] || 0;
    };
    const ceros = lista.filter((e) => !e.liquidity && !e.volume).length;
    console.log(
      `  ${plataforma}: liquidez ${mediana('liquidity').toFixed(0)}, ` +
      `volumen ${mediana('volume').toFixed(0)}, ` +
      `eventos sin ninguna de las dos: ${ceros}/${lista.length}`
    );
  }

  // Segundo: para los eventos que sí se contrastan, el desglose completo del
  // consenso, cotización a cotización y con el peso que recibe cada una.
  const cruzados = clusterEvents(events).filter((c) => c.events.length > 1);
  console.log(`\nEventos contrastados entre plataformas: ${cruzados.length}`);

  for (const cluster of cruzados.slice(0, 3)) {
    line();
    console.log(`${trunc(cluster.anchor.title, 64)}`);
    for (const e of cluster.events) {
      console.log(`  fuente: ${e.platformLabel} — "${trunc(e.title, 48)}"`);
      console.log(`          liquidez=${(e.liquidity || 0).toFixed(0)} volumen=${(e.volume || 0).toFixed(0)} opciones=${e.options.length}`);
    }

    const { options: grupos, descartadas } = canonicalizeOptions(cluster);
    const conVarias = grupos.filter((g) => g.quotes.length > 1);
    console.log(`  opciones canónicas: ${grupos.length} (cotizadas por más de una plataforma: ${conVarias.length}, descartadas por no estar en el ancla: ${descartadas})`);

    const top = [...grupos]
      .sort((a, b) => {
        const p = (g) => Math.max(...g.quotes.map((q) => q.option.impliedProb || 0));
        return p(b) - p(a);
      })
      .slice(0, 4);

    for (const g of top) {
      console.log(`  · "${trunc(g.label, 34)}"`);
      for (const q of g.quotes) {
        const w = quoteWeight(q);
        console.log(
          `      ${q.platformLabel.padEnd(20)} ${((q.option.impliedProb || 0) * 100).toFixed(1).padStart(5)}%` +
          `  peso=${w.toFixed(2)}  (liq=${(q.option.liquidity || 0).toFixed(0)} vol=${(q.option.volume || 0).toFixed(0)} spread=${q.option.spread === null ? 'n/d' : q.option.spread.toFixed(3)})`
        );
      }
    }
  }
}

async function main() {
  await diagnoseKalshi();
  console.log();
  await diagnoseMatching();
  console.log();
  await diagnosePonderacion();
  console.log('\nPega esta salida entera en la conversación.');
}

main().catch((err) => {
  console.error('El diagnóstico no pudo completarse:', err.message);
  process.exit(1);
});
