#!/usr/bin/env node
'use strict';

// Comprobación de despliegue: llama a las APIs reales de las tres plataformas y
// verifica que lo que devuelven se sigue pudiendo parsear y analizar.
//
//   npm run smoke
//
// Sale con código 1 si alguna fuente falla o si el análisis no produce ningún
// evento, para poder encadenarlo en un script de despliegue. Con --tolerante
// sólo falla si caen TODAS las fuentes, que es el criterio razonable para un
// reinicio automático: el agregador funciona con las que respondan.

const providers = require('../src/providers');
const { analyzeEvents } = require('../src/analyze');
const { getKlines, BINANCE_API } = require('../src/klines');
const { analyzeBreakout } = require('../src/breakout');
const { evaluateSignals } = require('../src/signals');
const { fetchAllPrices } = require('../src/venues');
const { consolidate } = require('../src/consolidated');

const TOLERANTE = process.argv.includes('--tolerante');

function trunc(text, max = 90) {
  const clean = String(text).replace(/\s+/g, ' ');
  return clean.length > max ? clean.slice(0, max) + '…' : clean;
}

// El gráfico depende de Binance igual que el analizador de las tres
// plataformas de predicción, y hasta ahora el smoke test no lo miraba: se podía
// desplegar con /api/klines roto y enterarse por un usuario.
async function comprobarMercado() {
  console.log(`Consultando Binance (${BINANCE_API})...\n`);

  try {
    const inicio = Date.now();
    const { candles } = await getKlines({ symbol: 'BTCUSDT', interval: '1h', limit: 400 });
    const elapsed = Date.now() - inicio;

    if (candles.length < 60) {
      console.log(`  FALLO Binance: sólo ${candles.length} velas utilizables; el análisis necesita 60.`);
      return false;
    }

    const ultima = candles[candles.length - 1];
    console.log(`  OK    Binance: ${candles.length} velas de 1h en ${elapsed} ms (BTCUSDT a ${ultima.close})`);

    const ruptura = analyzeBreakout(candles, { interval: '1h' });
    if (!ruptura.ok) {
      console.log(`  FALLO Análisis de ruptura: ${ruptura.reason}`);
      return false;
    }

    console.log(`  OK    Ruptura: ${ruptura.explanation[1]}`);
    repasarSenales(candles, '1h');
    return true;
  } catch (err) {
    console.log(`  FALLO Binance: ${trunc(err.message)}`);
    return false;
  }
}

// Pasa el motor de señales por todo el histórico real, vela a vela, como si se
// hubiera vivido en directo. No es un backtest serio —no hay comisiones, ni
// deslizamiento, y los cruces de stop se miran al cierre y no dentro de la
// vela— pero responde a la pregunta que importa antes de fiarse de una
// alerta: sobre datos de verdad, ¿cuántas veces habría avisado, y cómo acabó
// cada aviso?
//
// Cada vela se recorre en cuatro momentos, y el orden importa: apertura (con
// la vela entera por delante, que es cuando un aviso previo tiene sentido),
// después el extremo que va EN CONTRA de la posición, luego el que va a
// favor, y por último el cierre. Mirar sólo apertura y cierre daba por bueno
// un objetivo alcanzado en una vela que antes había pasado por el stop, y eso
// infla el resultado. Ante la duda, pierde: es la convención honesta.
// Las señales se deduplican por su identificador, igual que en el navegador.
function repasarSenales(candles, interval = '1h') {
  const compras = [];
  const vistas = new Set();
  let position = null;
  let avisos = 0;

  for (let i = 80; i < candles.length; i++) {
    const cerradas = candles.slice(0, i).map((c) => ({ ...c, closed: true }));
    const vela = candles[i];
    const ventana = [...cerradas, { ...vela, closed: false }];

    // El análisis se calcula al abrir la vela: es el que vería quien la mira
    // empezar, y sin él el motor no puede emitir avisos previos.
    const analisis = analyzeBreakout(ventana, { interval, now: vela.openTime + 1, livePrice: vela.open });

    const medio = vela.openTime + Math.round((vela.closeTime - vela.openTime) / 2);
    // Perezosos: el lado de la posición puede cambiar dentro de la propia vela.
    const pasos = [
      () => ({ price: vela.open, now: vela.openTime + 1, breakout: analisis }),
      () => ({ price: position && position.side === 'corta' ? vela.high : vela.low, now: medio, breakout: null }),
      () => ({ price: position && position.side === 'corta' ? vela.low : vela.high, now: medio, breakout: null }),
      () => ({ price: vela.close, now: vela.closeTime, breakout: null }),
    ];

    for (const paso of pasos) {
      const momento = paso();
      const { signals, position: siguiente } = evaluateSignals({
        candles: ventana,
        position,
        symbol: 'BTCUSDT',
        interval,
        ...momento,
      });

      for (const s of signals) {
        if (vistas.has(s.id)) continue;
        vistas.add(s.id);

        if (s.type === 'aviso') avisos++;
        else if (s.action === 'comprar') compras.push({ entrada: s.price, abierta: true });
        else if (s.action.startsWith('vender_') && compras.length) {
          const ultima = compras[compras.length - 1];
          ultima.abierta = false;
          ultima.salida = s.price;
          ultima.motivo = s.reason;
          ultima.resultado = s.change;
        }
      }
      position = siguiente;
    }
  }

  if (!compras.length) {
    console.log(`  INFO  Señales: ninguna compra en ${candles.length - 80} velas (${avisos} avisos previos). El sistema exige cierre fuera del nivel y volumen.`);
    return;
  }

  const cerradas = compras.filter((c) => !c.abierta);
  const ganadoras = cerradas.filter((c) => c.resultado > 0).length;
  const media = cerradas.length ? cerradas.reduce((a, c) => a + c.resultado, 0) / cerradas.length : 0;
  const motivos = {};
  for (const c of cerradas) motivos[c.motivo] = (motivos[c.motivo] || 0) + 1;

  // Las comisiones se restan a la vista: sin ellas, una media de dos décimas
  // parece una ventaja y en un mercado al contado no lo es.
  const COMISION_IDA_Y_VUELTA = 0.002;
  const neta = media - COMISION_IDA_Y_VUELTA;

  // Y la media se acompaña de su error típico. Una media de diez operaciones
  // sin dispersión al lado invita a leer una ventaja donde sólo hay ruido: si
  // el error típico es mayor que la media, el resultado es indistinguible de
  // cero por muy redondo que parezca el número.
  const resultados = cerradas.map((c) => c.resultado);
  const varianza = resultados.length > 1
    ? resultados.reduce((a, r) => a + (r - media) ** 2, 0) / (resultados.length - 1)
    : 0;
  const errorTipico = resultados.length ? Math.sqrt(varianza) / Math.sqrt(resultados.length) : 0;
  const concluyente = Math.abs(neta) > 2 * errorTipico && resultados.length >= 30;

  console.log(
    `  INFO  Señales sobre el histórico real: ${compras.length} compras (${cerradas.length} cerradas, ` +
      `${ganadoras} en positivo), media ${(media * 100).toFixed(2)}% bruto por operación, ${avisos} avisos previos.`
  );
  console.log(`        Motivos de venta: ${Object.entries(motivos).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}`);
  console.log(
    `        Con 0,2% de comisión ida y vuelta: ${(neta * 100).toFixed(2)}% ± ${(errorTipico * 100).toFixed(2)}% ` +
      `(error típico) por operación.`
  );
  console.log(
    concluyente
      ? '        La media supera dos errores típicos con muestra suficiente, pero un solo par y un solo tramo siguen sin ser una demostración.'
      : `        Indistinguible de cero: con ${cerradas.length} operaciones el ruido es mayor que la media. ` +
        'Es una comprobación de comportamiento, no un backtest.'
  );
  console.log('        Los stops se miran contra el mínimo y el máximo de cada vela, y ante la duda pierde.');
}

// Los tres mercados al contado. Sus formatos se prueban con servidores
// locales que los imitan, pero que sigan respondiendo eso sólo lo dice una
// llamada de verdad — y aquí además se ve lo único que importa del
// consolidado: cuánto discrepan hoy.
async function comprobarPrecios() {
  console.log('Consultando Binance, Kraken y Coinbase...\n');

  const quotes = await fetchAllPrices({ symbol: 'BTCUSDT', timeoutMs: 8000 });
  const out = consolidate(quotes);

  for (const v of out.venues) {
    if (v.usable) {
      console.log(`  OK    ${v.label.padEnd(9)} ${v.pair.padEnd(9)} ${v.price} (${v.diff >= 0 ? '+' : ''}${v.diffPct}%) en ${v.elapsedMs} ms`);
    } else {
      console.log(`  FALLO ${v.label.padEnd(9)} ${v.pair.padEnd(9)} ${trunc(v.error || 'sin precio utilizable')}`);
    }
  }

  if (out.price === null) {
    console.log('\n  Ningún mercado al contado responde: el precio consolidado no se puede calcular.');
    return false;
  }

  console.log(`\n  Consolidado: ${out.price} (${out.method}, ${out.used} de ${out.venues.length}) · ${out.agreement} · diferencia ${out.spread} (${out.spreadPct}%)`);
  if (out.used < out.venues.length) {
    console.log('  Aviso: falta algún mercado, así que el consolidado es menos robusto de lo previsto.');
  }
  console.log('  Parte de esa diferencia es que Binance cotiza en USDT y los otros dos en dólares.');

  return out.used >= 2;
}

async function main() {
  const preciosOk = await comprobarPrecios();
  console.log('');
  const mercadoOk = await comprobarMercado();
  console.log('');
  console.log('Consultando Polymarket, Robinhood/Kalshi y Manifold...\n');

  const { events, sources } = await providers.fetchAll({ limit: 100, timeoutMs: 20000 });

  let caidas = 0;
  for (const s of sources) {
    if (s.ok && s.events > 0) {
      console.log(`  OK    ${s.platformLabel}: ${s.events} eventos en ${s.elapsedMs} ms`);
    } else if (s.ok) {
      // Responde pero no devuelve nada: normalmente significa que cambió el
      // formato y el parser descarta todo, no que no haya mercados abiertos.
      caidas++;
      console.log(`  VACÍO ${s.platformLabel}: respondió sin eventos utilizables (¿cambió el formato?)`);
    } else {
      caidas++;
      console.log(`  FALLO ${s.platformLabel}: ${trunc(s.error)}`);
    }
  }

  const analyses = analyzeEvents(events, { limit: 500 });
  const cruzados = analyses.filter((a) => a.crossPlatform).length;

  console.log(`\n${events.length} eventos crudos → ${analyses.length} analizados, ${cruzados} contrastados entre plataformas.`);

  if (analyses.length === 0) {
    console.error('\nNingún evento analizable. El despliegue no está sirviendo nada útil.');
    process.exit(1);
  }

  console.log('\nMuestra:');
  for (const a of analyses.slice(0, 3)) {
    console.log(`  · ${trunc(a.title, 70)}`);
    console.log(`      ${a.verdict.text}`);
  }

  if (cruzados === 0) {
    console.log(
      '\nAviso: ninguna coincidencia entre plataformas. Puede ser normal si cada una\n' +
      'cubre temas distintos hoy, pero si se repite revisa el umbral de emparejamiento.'
    );
  }

  const falloTotal = TOLERANTE ? caidas === sources.length : caidas > 0;
  if (falloTotal) {
    console.error(`\n${caidas} de ${sources.length} fuentes no están utilizables.`);
    process.exit(1);
  }

  // El consolidado aguanta con dos de tres; con menos, el titular se queda en
  // un solo mercado y deja de cumplir su función.
  if (!preciosOk) {
    if (TOLERANTE) {
      console.log('\nAviso: menos de dos mercados al contado disponibles; el precio no será consolidado.');
    } else {
      console.error('\nMenos de dos mercados al contado disponibles: el precio consolidado no es fiable.');
      process.exit(1);
    }
  }

  // Binance alimenta la mitad de la aplicación: si falla, el despliegue está
  // roto aunque las predicciones vayan bien. En modo tolerante sólo se avisa.
  if (!mercadoOk) {
    if (TOLERANTE) {
      console.log('\nAviso: Binance no responde; el gráfico y el análisis de ruptura no funcionarán.');
    } else {
      console.error('\nBinance no está utilizable: el gráfico y el análisis de ruptura no funcionarán.');
      process.exit(1);
    }
  }

  console.log('\nTodo correcto.');
}

main().catch((err) => {
  console.error('El smoke test no pudo completarse:', err.message);
  process.exit(1);
});
