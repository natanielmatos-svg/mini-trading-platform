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

require('../src/env'); // un .env, si lo hay, antes que los módulos que leen process.env
const providers = require('../src/providers');
const { analyzeEvents } = require('../src/analyze');
const { getKlines, BINANCE_API } = require('../src/klines');
const { analyzeBreakout } = require('../src/breakout');
const { evaluateSignals } = require('../src/signals');
const { fetchAllPrices, VENUES } = require('../src/venues');
const { getVelasConsolidadas } = require('../src/velas-consolidadas');
const volatilidad = require('../src/volatilidad');
const alpaca = require('../src/alpaca');
const stocks = require('../src/stocks');
const { consolidate } = require('../src/consolidated');
const { formatPrice, num, priceDecimals } = require('../src/format');

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
  console.log(`Consultando ${VENUES.map((v) => v.meta.label).join(', ')}...\n`);

  // Se preguntan TODAS, incluidas las que no entran en la selección por
  // defecto: el trabajo de esta comprobación es saber si cada fuente responde,
  // y una fuente opcional que lleva meses rota también hay que descubrirla.
  const todas = VENUES.map((v) => v.meta.id);
  const quotes = await fetchAllPrices({ symbol: 'BTCUSDT', timeoutMs: 8000, venues: todas });

  const esOpcional = (id) => Boolean(VENUES.find((v) => v.meta.id === id).meta.optIn);
  const porDefecto = quotes.filter((q) => !esOpcional(q.id));
  const opcionales = quotes.filter((q) => esOpcional(q.id));

  // El consolidado se calcula con las de por defecto, que es lo que hace la
  // aplicación; las opcionales se informan aparte y no lo mueven.
  const out = consolidate(porDefecto);

  for (const v of out.venues) {
    if (v.usable) {
      console.log(
        `  OK    ${v.label.padEnd(9)} ${v.pair.padEnd(9)} ${formatPrice(v.price).padStart(12)} ` +
          `${((v.diff >= 0 ? '+' : '') + num(v.diffPct, 4) + '%').padStart(10)}  ${String(v.source || '?').padEnd(16)} en ${v.elapsedMs} ms`
      );
    } else {
      console.log(`  FALLO ${v.label.padEnd(9)} ${v.pair.padEnd(9)} ${trunc(v.error || 'sin precio utilizable')}`);
    }
  }

  if (out.price === null) {
    console.log('\n  Ningún mercado al contado responde: el precio consolidado no se puede calcular.');
    return false;
  }

  console.log(
    `\n  Consolidado: ${formatPrice(out.price)} (${out.method}, ${out.used} de ${out.venues.length}) · ` +
      `${out.agreement} · diferencia ${num(out.spread, priceDecimals(out.price))} (${num(out.spreadPct, 4)}%)`
  );
  if (out.used < out.venues.length) {
    console.log('  Aviso: falta algún mercado, así que el consolidado es menos robusto de lo previsto.');
  }
  const convertidos = out.venues.filter((v) => v.converted);
  const sinConvertir = out.venues.filter((v) => v.quote === 'USDT' && v.usable && !v.converted);

  if (convertidos.length) {
    const s = convertidos[0].stable;
    console.log(
      `  USDT/USD ${num(s.rate, 6)} (${s.source}): ` +
        convertidos.map((v) => `${v.label} ${formatPrice(v.priceRaw)} → ${formatPrice(v.price)}`).join(', ')
    );
  } else if (sinConvertir.length) {
    console.log(`  Aviso: no se pudo medir el USDT/USD, así que ${sinConvertir.map((v) => v.label).join(', ')} va sin convertir y arrastra el desvío de la stablecoin.`);
  }

  const porOperacion = out.venues.filter((v) => v.usable && v.source !== 'libro');
  if (porOperacion.length) {
    console.log(`  Ojo: ${porOperacion.map((v) => v.label).join(', ')} sin libro; su precio es la última operación y puede ser viejo.`);
  }
  console.log('  Se compara el punto medio del libro de cada casa, que siempre es de ahora.');

  if (opcionales.length) {
    console.log('\n  Fuentes opcionales (no entran en el consolidado; hay que marcarlas):');
    for (const v of opcionales) {
      if (v.ok && v.price > 0) {
        const dif = out.price ? ((v.price - out.price) / out.price) * 100 : null;
        console.log(
          `  OK    ${v.label.padEnd(9)} ${String(v.pair).padEnd(9)} ${formatPrice(v.price).padStart(12)} ` +
            `${(dif === null ? '' : (dif >= 0 ? '+' : '') + num(dif, 4) + '%').padStart(10)}  ${String(v.source || '?').padEnd(16)} en ${v.elapsedMs} ms`
        );
      } else {
        console.log(`  FALLO ${v.label.padEnd(9)} ${String(v.pair).padEnd(9)} ${trunc(v.error || 'sin precio utilizable')}`);
      }
    }
    console.log('  Un fallo aquí no rompe el despliegue: son opcionales y nadie las usa si no las marca.');
  }

  return out.used >= 2;
}

// Acciones. Es la única fuente con clave, así que aquí se comprueba sobre todo
// que la clave sirve: el error de Alpaca cuando no vale es un 403 seco, y
// enterarse por la página en blanco de un usuario es la peor forma.
async function comprobarAcciones() {
  if (!alpaca.hayClave()) {
    console.log('  OMITIDO Alpaca: sin ALPACA_KEY_ID / ALPACA_SECRET_KEY.');
    console.log('          /acciones.html funcionará con datos de ejemplo. La cuenta gratuita sirve:');
    console.log('          https://alpaca.markets/');
    return null; // ni bien ni mal: no se ha probado
  }

  try {
    const reloj = await alpaca.fetchClock();
    const cuando = reloj.isOpen ? reloj.nextClose : reloj.nextOpen;
    const cuenta = /paper-api/.test(reloj.api || '') ? 'papel' : 'real';
    console.log(
      `  OK    Reloj del mercado (cuenta de ${cuenta}): ${reloj.isOpen ? 'abierto' : 'cerrado'}` +
        (cuando ? ` · ${reloj.isOpen ? 'cierra' : 'abre'} ${new Date(cuando).toISOString()}` : '')
    );

    const inicio = Date.now();
    const { candles, source, fueraDeSesion } = await alpaca.fetchCandles({
      symbol: 'AAPL', interval: '1h', limit: 400, soloSesion: stocks.enSesion,
    });
    const elapsed = Date.now() - inicio;

    if (candles.length < 60) {
      console.log(`  FALLO Alpaca: sólo ${candles.length} velas utilizables; el análisis necesita 60.`);
      return false;
    }

    const ultima = candles[candles.length - 1];
    console.log(`  OK    ${source}: ${candles.length} velas de 1h en ${elapsed} ms (AAPL a ${formatPrice(ultima.close)})`);

    if (fueraDeSesion > 0) {
      console.log(`  INFO  ${fueraDeSesion} barras de horario extendido descartadas (quedan ${candles.length} de sesión)`);
    }

    // El libro se pide igual aunque esté cerrado: es justo cuando devuelve
    // basura, y lo que se comprueba aquí es que la basura NO pase.
    try {
      const cotiz = await alpaca.fetchQuote({ symbol: 'AAPL' });
      console.log(`  OK    Precio AAPL: ${formatPrice(cotiz.price)} (horquilla ${num(cotiz.horquilla * 100, 3)}%, feed ${cotiz.feed})`);
    } catch (err) {
      console.log(`  OK    Libro rechazado, como debe: ${trunc(err.message, 95)}`);
      try {
        const q = await stocks.getStockQuote({ symbol: 'AAPL' });
        console.log(`        Se usa el cierre: ${formatPrice(q.price)} de ${new Date(q.at).toISOString()}`);
      } catch (err2) {
        // No invalida la clave: el reloj y las velas acaban de funcionar con
        // ella. Decir "revisa tus credenciales" aquí manda a buscar donde no
        // está el problema.
        console.log(`  AVISO no se pudo fechar un precio de respaldo: ${trunc(err2.message, 90)}`);
      }
    }

    // Y el mismo análisis que en cripto, sobre velas de bolsa.
    const ruptura = analyzeBreakout(candles, { interval: '1h' });
    if (!ruptura.ok) {
      console.log(`  FALLO Ruptura sobre acciones: ${ruptura.reason}`);
      return false;
    }
    console.log(`  OK    Ruptura: ${ruptura.explanation[1]}`);
    return true;
  } catch (err) {
    console.log(`  FALLO Alpaca: ${trunc(err.message)}`);
    return false;
  }
}

// Consolidar las velas, ¿cambia el análisis o es cosmético?
//
// Sobre datos sintéticos el ATR bajaba un 6,7% y la volatilidad un 11%: la
// mediana cancela el ruido propio de cada casa, y el ATR es el denominador de
// toda distancia a un nivel. Pero el ruido que puse era el que me inventé.
// Esto lo mide con mercados de verdad, que es la única forma de saberlo.
async function compararConsolidado() {
  try {
    const [soloBinance, consolidado] = await Promise.all([
      getKlines({ symbol: 'BTCUSDT', interval: '1h', limit: 400 }),
      getVelasConsolidadas({ symbol: 'BTCUSDT', interval: '1h', limit: 400 }),
    ]);

    if (!consolidado.ok) {
      console.log(`  AVISO sin consolidado: ${consolidado.motivo}`);
      for (const v of consolidado.venues.filter((x) => !x.usado)) console.log(`        ${v.label}: ${v.motivo}`);
      return;
    }

    const usados = consolidado.venues.filter((v) => v.usado).map((v) => v.label).join(', ');
    console.log(`  OK    Velas consolidadas: ${consolidado.candles.length} de ${consolidado.usados} mercados (${usados})`);
    for (const v of consolidado.venues.filter((x) => !x.usado)) console.log(`        fuera ${v.label}: ${v.motivo}`);

    const a = analyzeBreakout(soloBinance.candles, { interval: '1h' });
    const b = analyzeBreakout(consolidado.candles, { interval: '1h' });
    if (!a.ok || !b.ok) return;

    const va = volatilidad.medir(soloBinance.candles, '1h');
    const vb = volatilidad.medir(consolidado.candles, '1h');
    const dif = (x, y) => (x && y ? `${((y - x) / x) * 100 >= 0 ? '+' : ''}${num(((y - x) / x) * 100, 2)}%` : '—');

    console.log('\n        qué cambia al consolidar     Binance    consolidado   diferencia');
    console.log(`        ATR(14)                  ${formatPrice(a.atr).padStart(11)} ${formatPrice(b.atr).padStart(14)} ${dif(a.atr, b.atr).padStart(12)}`);
    if (a.up && b.up) {
      console.log(`        nivel al alza            ${formatPrice(a.up.level).padStart(11)} ${formatPrice(b.up.level).padStart(14)} ${dif(a.up.level, b.up.level).padStart(12)}`);
      console.log(`        probabilidad al alza     ${(num(a.up.probability * 100, 1) + '%').padStart(11)} ${(num(b.up.probability * 100, 1) + '%').padStart(14)} ${dif(a.up.probability, b.up.probability).padStart(12)}`);
    }
    if (va.ok && vb.ok) {
      console.log(`        volatilidad anual        ${(num(va.anualizada * 100, 1) + '%').padStart(11)} ${(num(vb.anualizada * 100, 1) + '%').padStart(14)} ${dif(va.anualizada, vb.anualizada).padStart(12)}`);
      console.log(`        régimen                  ${va.regimen.padStart(11)} ${vb.regimen.padStart(14)}`);
    }
    console.log('');
  } catch (err) {
    console.log(`  FALLO comparación consolidada: ${trunc(err.message)}`);
  }
}

async function main() {
  const preciosOk = await comprobarPrecios();
  console.log('');
  const mercadoOk = await comprobarMercado();
  console.log('');
  console.log('Consolidando velas de los mercados al contado...\n');
  await compararConsolidado();
  console.log('Consultando Alpaca (acciones)...\n');
  const accionesOk = await comprobarAcciones();
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

  // Sin clave no se ha probado nada, así que no se falla por ello: la página
  // de acciones sigue arrancando con datos de ejemplo.
  if (accionesOk === false) {
    if (TOLERANTE) {
      console.log('\nAviso: Alpaca no responde; /acciones.html caerá a datos de ejemplo.');
    } else {
      console.error('\nAlpaca no está utilizable: revisa ALPACA_KEY_ID y ALPACA_SECRET_KEY.');
      process.exit(1);
    }
  }

  console.log('\nTodo correcto.');
}

main().catch((err) => {
  console.error('El smoke test no pudo completarse:', err.message);
  process.exit(1);
});
