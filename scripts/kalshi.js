#!/usr/bin/env node
'use strict';

// ¿Hay alguna operación en Kalshi ahora mismo, según lo que sabe esta app?
//
//   npm run kalshi -- --serie KXBTCD --capital 500
//
// LEE Y CALCULA. NO ENVÍA ÓRDENES: este archivo no tiene forma de hacerlo, y
// es a propósito. La mitad que decide se puede comprobar entera sin tocar una
// cuenta; la que ejecuta necesita claves y va aparte, para que nadie mueva
// dinero por ejecutar un script de diagnóstico.
//
// Lo que imprime está pensado para leerse antes de confiar en nada:
//
//   · las tres constantes que más fácil convierten una ventaja en pérdida
//     —comisión, ruido de base y capital— se enseñan arriba, no se esconden;
//   · de cada mercado se dice POR QUÉ no se opera, no sólo que no;
//   · si de cuarenta mercados no se entiende ninguno, lo dice, en vez de
//     parecer que hoy no había oportunidades.

require('../src/env');

const { getKlines } = require('../src/klines');
const { predecirHorizontes, seriesNecesarias } = require('../src/prediccion');
const { listarMercados, explorarSeries, mercadosDemo, KALSHI_BASE } = require('../src/kalshi-mercados');
const edge = require('../src/kalshi-edge');
const { formatPrice, num, formatDuration } = require('../src/format');

function arg(nombre, pordefecto = null) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : pordefecto;
}

const OPCIONES = {
  serie: arg('serie', process.env.KALSHI_SERIE || 'KXBTCD'),
  symbol: arg('symbol', process.env.KALSHI_SYMBOL || 'BTCUSDT'),
  interval: arg('interval', '1h'),
  capital: Number(arg('capital', process.env.KALSHI_CAPITAL || 500)),
  ruidoBase: Number(arg('base', process.env.KALSHI_RUIDO_BASE || edge.LIMITES.ruidoBase)),
  todos: process.argv.includes('--todos'),
  demo: process.argv.includes('--demo'),
  explorar: process.argv.includes('--explorar'),
  buscar: arg('buscar', null),
  // Cuántos céntimos se desplaza el mercado de mentira respecto a lo que
  // nosotros creemos. Sirve para ver el camino positivo funcionando sin
  // inventarse que el bot encuentra ventaja: con 0 el mercado nos da la razón
  // y no hay nada que operar, que es el resultado honesto.
  sesgo: Number(arg('sesgo', 0)),
};

const cents = (p) => (p === null || p === undefined ? ' — ' : `${(p * 100).toFixed(0)}¢`);

function cabecera() {
  console.log('Escáner de Kalshi — lee y calcula, no envía órdenes\n');
  if (OPCIONES.demo) {
    console.log('  *** MODO DEMO: velas de ejemplo y mercados INVENTADOS. Nada de esto es real. ***\n');
  }
  console.log(`  API            ${OPCIONES.demo ? '(ninguna: modo demo)' : KALSHI_BASE}`);
  console.log(`  serie          ${OPCIONES.serie}`);
  console.log(`  activo         ${OPCIONES.symbol} (velas de Binance)`);
  console.log(`  capital        ${OPCIONES.capital} $`);
  console.log('');
  console.log('  Supuestos que hay que comprobar antes de poner dinero:');
  console.log(`    · comisión    ${edge.TASA_COMISION} × contratos × P × (1−P), redondeada hacia arriba.`);
  console.log(`                  Un contrato a 50¢ paga ${edge.comision(1, 0.5).toFixed(2)} $, el 4% de lo que arriesgas.`);
  console.log('                  COMPRUÉBALA contra el calendario vigente de Kalshi.');
  console.log(`    · ruido base  ${(OPCIONES.ruidoBase * 100).toFixed(3)}% — cuánto puede separarse el índice que`);
  console.log('                  liquida Kalshi de nuestra mediana de exchanges. Esto hay que');
  console.log('                  MEDIRLO: es el número que más fácil convierte una ventaja');
  console.log('                  en una pérdida, y ahora mismo es una suposición.');
  console.log(`    · calibración se exige que la banda del 90% haya contenido entre el`);
  console.log(`                  ${((0.9 - edge.LIMITES.errorCalibracionMax) * 100).toFixed(0)}% y el ${((0.9 + edge.LIMITES.errorCalibracionMax) * 100).toFixed(0)}% sobre el histórico, o ese plazo no se opera.`);
  console.log('');
}

// Antes de nada: qué series hay y cuáles se entienden. Un `series_ticker`
// equivocado devuelve cero mercados en silencio, y eso se lee como «hoy no hay
// oportunidades» cuando en realidad es «te has equivocado de nombre».
async function explorar() {
  console.log('Series abiertas en Kalshi\n');
  console.log(`  ${KALSHI_BASE}`);
  if (OPCIONES.buscar) console.log(`  filtrando por «${OPCIONES.buscar}»`);
  console.log('');

  const { total, series, diagnostico } = await explorarSeries({
    filtro: OPCIONES.buscar,
    paginas: Number(arg('paginas', 25)),
  });

  if (!series.length) {
    console.log(`Se miraron ${total} mercados en ${diagnostico.paginas} página(s) y no salió ninguna serie${OPCIONES.buscar ? ' con ese filtro' : ''}.`);
    console.log('');
    console.log('Qué respondió la API, para no quedarse adivinando:');
    console.log(`  campos de arriba   ${JSON.stringify(diagnostico.envoltura)}`);
    console.log(`  eventos vistos     ${diagnostico.eventos}${diagnostico.agotado ? ' (el listado entero)' : ' (quedaban más páginas)'}`);
    console.log(`  combinadas MVE     ${diagnostico.mve} (saltadas: no son una opción de un evento)`);
    if (diagnostico.campos) console.log(`  campos de un mercado ${JSON.stringify(diagnostico.campos)}`);
    console.log(`  primeros bytes     ${diagnostico.muestra}`);
    console.log('');
    if (total > 0 && OPCIONES.buscar) {
      console.log(`Había ${total} mercados: el filtro «${OPCIONES.buscar}» es lo que los dejó fuera. Prueba sin él.`);
    } else if (total === 0) {
      console.log('Cero mercados. O la respuesta no trae `markets`, o el endpoint pide otros parámetros.');
      console.log('Pégame los «primeros bytes» de arriba y lo arreglo.');
    }
    return;
  }

  console.log(`  serie                 mercados  entendidos  vence antes  <24h  formas      ejemplo`);
  console.log('  ' + '-'.repeat(112));
  for (const e of series.slice(0, 40)) {
    console.log(
      '  ' + e.serie.padEnd(20) +
      String(e.mercados).padStart(9) + '  ' +
      String(e.entendidos).padStart(10) + '  ' +
      (e.vencePronto === null ? '—' : formatDuration(e.vencePronto)).padStart(11) + '  ' +
      String(e.dentroDeUnDia).padStart(4) + '  ' +
      (e.formas.join('/') || '—').padEnd(10) + '  ' +
      String(e.ejemplo || '').slice(0, 34)
    );
  }
  console.log('');
  console.log(`De ${diagnostico.eventos} eventos y ${total} mercados en ${diagnostico.paginas} página(s), ${series.length} series.`);
  if (diagnostico.mve) {
    console.log(`Se saltaron ${diagnostico.mve} mercados «MVE»: son apuestas combinadas de varias patas,`);
    console.log('no una opción de un evento, y este motor no las valora.');
  }
  if (diagnostico.agotado) {
    console.log('Se recorrió el listado ENTERO: lo que no esté aquí, no está abierto ahora mismo.');
  } else {
    console.log(`Quedaban más páginas por mirar (el corte son ${arg('paginas', 25)}). Con --paginas N se llega más hondo,`);
    console.log('y hasta que diga «listado entero» no se puede concluir que una serie no existe.');
  }
  console.log('');
  console.log('Dos columnas deciden, y ninguna es el volumen:');
  console.log('  · «entendidos» — una serie de la que entendemos cero no se puede operar.');
  console.log(`  · «<24h» — cuántos contratos vencen dentro del plazo en el que este motor`);
  console.log('    está medido. Una serie a ocho días se descarta entera, por buena que sea:');
  console.log('    a ese plazo el modelo no está calibrado y prefiere no opinar.');
  console.log('');
  console.log('Coge una con las dos columnas altas y pásala con --serie.');
}

async function main() {
  if (OPCIONES.explorar) return explorar();
  cabecera();

  // 1. Las velas y la predicción, igual que las calcula el servidor.
  const necesarias = seriesNecesarias(OPCIONES.interval);
  const series = {};
  for (const tf of necesarias) {
    const r = await getKlines({ symbol: OPCIONES.symbol, interval: tf, limit: 400, demo: OPCIONES.demo });
    series[tf] = r.candles;
  }

  const velas = series[OPCIONES.interval] || series[necesarias[0]];
  const precio = velas[velas.length - 1].close;
  console.log(`Precio de ${OPCIONES.symbol}: ${formatPrice(precio)}\n`);

  const horizontes = await predecirHorizontes({ series, interval: OPCIONES.interval });
  const utiles = horizontes.filter((h) => h.ok);
  if (!utiles.length) {
    console.error('No hay ningún horizonte utilizable: sin predicción no hay nada que comparar.');
    process.exitCode = 1;
    return;
  }

  console.log('Calibración medida (la banda del 90%, sobre el histórico):');
  for (const h of utiles) {
    const c = h.calibracion && h.calibracion.ok && h.calibracion.cobertura.find((x) => x.nominal === 0.9);
    const nota = c ? `${(c.observada * 100).toFixed(0)}%` : 'sin medir';
    const vale = c && Math.abs(c.observada - 0.9) <= edge.LIMITES.errorCalibracionMax;
    console.log(`  ${formatDuration(h.ms).padEnd(9)} ${nota.padStart(9)}   ${vale ? 'operable' : 'NO operable'}`);
  }
  console.log('');

  // 2. Los mercados de Kalshi.
  let lista;
  try {
    lista = OPCIONES.demo
      ? mercadosDemo({ precio, horizontes, sesgo: OPCIONES.sesgo, symbol: OPCIONES.symbol })
      : await listarMercados({ serie: OPCIONES.serie });
  } catch (err) {
    console.error(`No se pudo leer Kalshi: ${err.message}`);
    console.error('Si es un 404, el series_ticker no existe: compruébalo en kalshi.com antes de nada.');
    process.exitCode = 1;
    return;
  }

  console.log(`Kalshi devolvió ${lista.total} mercados abiertos de ${lista.serie}; se entienden ${lista.entendidos}.`);
  if (lista.total > 0 && lista.entendidos === 0) {
    console.error('\nNinguno se pudo interpretar. Eso NO significa que no haya oportunidades:');
    console.error('significa que los campos que leemos (strike_type, floor_strike, cap_strike)');
    console.error('no vienen como esperamos. Hay que arreglarlo antes de operar nada.');
    process.exitCode = 1;
    return;
  }
  console.log('');

  // 3. La decisión, mercado a mercado.
  const ctx = { precio, capital: OPCIONES.capital, limites: { ruidoBase: OPCIONES.ruidoBase } };
  const resp = { horizontes };
  const operables = [];

  for (const m of lista.mercados) {
    const r = edge.evaluarMercado(m, resp, ctx);
    if (r.operar) operables.push({ m, r });
    else if (OPCIONES.todos) console.log(`  ·  ${m.ticker.padEnd(26)} ${r.motivo}`);
  }

  if (OPCIONES.todos) console.log('');

  if (!operables.length) {
    console.log('Ninguna operación pasa los filtros.');
    console.log('Es el resultado normal y el bueno: la mayor parte del tiempo el mercado');
    console.log('tiene razón, y un bot que encuentra ventaja en todo es un bot roto.');
    console.log('Con --todos se ve el motivo de cada descarte.');
    return;
  }

  console.log(`${operables.length} operación(es) pasan los filtros:\n`);
  console.log('  contrato                     vence    mercado   nosotros   neto   tamaño     coste');
  console.log('  ' + '-'.repeat(84));

  for (const { m, r } of operables) {
    console.log(
      '  ' + m.ticker.padEnd(26) +
      formatDuration(r.venceEnMs).padStart(8) + '  ' +
      `${cents(m.yesBid)}/${cents(m.yesAsk)}`.padStart(9) + '  ' +
      `${(r.p * 100).toFixed(0)}%`.padStart(8) + '  ' +
      `${(r.ev * 100).toFixed(1)}¢`.padStart(6) + '  ' +
      `${r.lado} ×${r.contratos}`.padStart(9) + '  ' +
      `${num(r.coste, 2)} $`.padStart(9)
    );
  }

  const coste = operables.reduce((a, x) => a + x.r.coste, 0);
  const ev = operables.reduce((a, x) => a + x.r.evTotal, 0);
  console.log('  ' + '-'.repeat(84));
  console.log(`  Coste total ${num(coste, 2)} $ · valor esperado ${num(ev, 2)} $ tras comisiones.`);
  console.log('');
  console.log('Esto es lo que un bot HARÍA. No se ha enviado nada: este script no puede.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
