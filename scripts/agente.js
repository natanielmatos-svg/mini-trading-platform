#!/usr/bin/env node
'use strict';

// El agente y el proceso que corre solo.
//
//   npm run agente                      mira, decide y anota, cada minuto
//   npm run agente -- reglas --serie KXBTCD --archivo reglamento.txt
//   npm run agente -- aprobar --serie KXBTCD --quien nat --base 0.0004
//                              [--indice "CF Benchmarks BRTI"]  para declararla a mano
//   npm run agente -- autopsia          qué ha hecho y por qué no ha hecho el resto
//
// NO ENVÍA ÓRDENES. Lleva una cartera de mentira: lo que habría comprado. Es el
// paso previo a poner dinero, y el que dice si merece la pena ponerlo.
//
// El agente sólo puede VETAR. No hay ninguna herramienta con la que autorice
// una operación, así que puede leer reglamentos, titulares y búsquedas —texto
// que no controlamos— sin que eso sea un agujero: el peor caso es que no se
// opere nada.

require('../src/env');

const fs = require('node:fs');
const path = require('node:path');

const { getKlines } = require('../src/klines');
const { predecirHorizontes, seriesNecesarias } = require('../src/prediccion');
const { listarMercados, mercadosDemo, KALSHI_BASE } = require('../src/kalshi-mercados');
const { crearBucle, reconstruir } = require('../src/bucle');
const vetos = require('../src/vetos');
const reglas = require('../src/reglas');
const registro = require('../src/registro');
const agente = require('../src/agente');
const { formatPrice, num } = require('../src/format');

function arg(nombre, pordefecto = null) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : pordefecto;
}
const tiene = (f) => process.argv.includes(`--${f}`);

const OP = {
  serie: arg('serie', process.env.KALSHI_SERIE || 'KXBTCD'),
  symbol: arg('symbol', process.env.KALSHI_SYMBOL || 'BTCUSDT'),
  interval: arg('interval', '1h'),
  capital: Number(arg('capital', require('../src/trading-settings').read().capital)),
  cada: Number(arg('cada', 60)) * 1000,
  vetosArchivo: arg('vetos', path.join(process.cwd(), 'vetos.json')),
  conAgente: tiene('agente'),
  conBusqueda: tiene('web'),
  demo: tiene('demo'),
};

// --- Subcomando: leer el reglamento de una serie ---------------------------

async function cmdReglas() {
  const archivo = arg('archivo');
  if (!archivo) return fallo('hace falta --archivo con el texto del reglamento');

  const texto = fs.readFileSync(archivo, 'utf8');
  console.log(`Leyendo el reglamento de ${OP.serie} (${texto.length} caracteres) con ${agente.MODELO}…\n`);

  const ficha = await agente.leerReglas({ serie: OP.serie, texto });
  reglas.anotarFicha(ficha);

  console.log(`  índice        ${ficha.indice || '(no lo dice)'}`);
  console.log(`  proveedor     ${ficha.proveedor || '(no lo dice)'}`);
  console.log(`  composición   ${ficha.composicion || '(no lo dice)'}`);
  console.log(`  hora          ${ficha.hora || '(no lo dice)'}`);
  console.log(`  confianza     ${ficha.confianza}`);
  console.log(`  se apoya en   «${(ficha.cita || '').slice(0, 200)}»`);
  console.log('');
  console.log('Guardada SIN aprobar. Léela, compruébala contra el reglamento y mide cuánto');
  console.log('se separa ese índice de nuestro precio. Después:');
  console.log(`  npm run agente -- aprobar --serie ${OP.serie} --quien TU-NOMBRE --base 0.0004`);
  console.log('');
  console.log('Hasta entonces el bot no operará esa serie. Es el estado por defecto a propósito:');
  console.log('un modelo leyendo un PDF ayuda a encontrar la frase, no decide dónde va el dinero.');
}

async function cmdAprobar() {
  const quien = arg('quien');
  const base = Number(arg('base'));
  if (!quien) return fallo('hace falta --quien: quién aprueba, con su nombre');
  if (!(base >= 0)) return fallo('hace falta --base: el ruido de base MEDIDO, en tanto por uno');

  const ficha = reglas.aprobar(OP.serie, { quien, ruidoBase: base, indice: arg('indice') });
  console.log(`${OP.serie} aprobada por ${ficha.aprobadoPor} el ${ficha.aprobadoEn}.`);
  console.log(`Ruido de base declarado: ${(base * 100).toFixed(3)}%.`);
}

// --- Subcomando: la autopsia ------------------------------------------------

async function cmdAutopsia() {
  const { entradas, rotas } = registro.leer({ desde: arg('desde') });
  if (!entradas.length) return console.log('El cuaderno está vacío. Deja el bucle corriendo un rato.');

  const r = registro.resumir(entradas);
  console.log(`Del ${r.desde} al ${r.hasta}${rotas ? ` (${rotas} líneas rotas, saltadas)` : ''}\n`);
  console.log(`  mercados vistos     ${r.vistas}`);
  console.log(`  habría operado      ${r.operables}`);
  console.log(`  vetados             ${r.vetadas}`);
  console.log(`  coste de papel      ${num(r.costeTotal, 2)} $`);
  console.log(`  valor esperado      ${num(r.evTotal, 2)} $ tras comisiones`);
  console.log('');
  console.log('  Por qué NO se operó:');
  for (const m of r.motivos) console.log(`    ${String(m.veces).padStart(6)}  ${m.motivo}`);
  console.log('');

  const posiciones = reconstruir(entradas);
  console.log(`  posiciones de papel abiertas ahora mismo: ${posiciones.size}`);
  for (const p of posiciones.values()) {
    console.log(`    ${p.ticker.padEnd(26)} ${p.lado} ×${p.contratos} a ${(p.precioEntrada * 100).toFixed(0)}¢`);
  }
  console.log('');
  console.log('El motivo que más se repite es el que hay que mirar: si el 90% de los descartes');
  console.log('son por calibración, el problema no está en los filtros, está en el modelo.');
}

// --- Subcomando por defecto: el bucle --------------------------------------

async function cmdVigilar() {
  const control=require('../src/bot-control');
  control.acquire();
  if(!fs.existsSync(path.join(__dirname,'../datos/bot-control.json')))control.save({...control.read(),agentEnabled:OP.conAgente});
  console.log('Agente y bucle — mira, decide y anota. NO envía órdenes.\n');
  console.log(`  API            ${OP.demo ? '(ninguna: modo demo)' : KALSHI_BASE}`);
  console.log(`  serie          ${OP.serie}`);
  console.log(`  activo         ${OP.symbol}`);
  console.log(`  capital        ${OP.capital} $ (de mentira)`);
  console.log(`  cada           ${OP.cada / 1000} s`);
  console.log(`  cuaderno       ${registro.RUTA}`);
  console.log('');
  console.log('  Fuentes de veto (sólo pueden impedir operar, nunca autorizar):');
  console.log(`    · operador   ${OP.vetosArchivo} — edítalo para parar el bot en caliente`);
  console.log(`    · reglas     ${reglas.RUTA} — una serie sin aprobar no se opera`);
  console.log(`    · agente     ${OP.conAgente ? `${agente.MODELO}${OP.conBusqueda ? ' con búsqueda web' : ''}` : 'apagado (--agente para encenderlo)'}`);
  console.log('');

  const fuentes = [
    vetos.fuenteArchivo(OP.vetosArchivo),
    reglas.fuenteReglas(),
  ];
  let agentBusy=false;
  const agentSource=agente.fuenteAgente({ activo: OP.symbol, conBusqueda: OP.conBusqueda });
  fuentes.push({nombre:'agente',async vetos(context){
    if(!control.read().agentEnabled)return [];
    agentBusy=true;
    try{return await agentSource.vetos(context);}finally{agentBusy=false;}
  }});

  // La predicción es cara: se recalcula cada dos minutos, no en cada vuelta.
  const evidencia = OP.demo ? null : require('../src/evidencia').crear();
  const book = require('../src/kalshi-book');
  let referencia = null;
  const liquidacion = require('../src/kalshi-settlement').fetchResult;
  let cache = { hasta: 0, valor: null, precio: null };
  async function prediccion() {
    const ahora = Date.now();
    if (!OP.demo) {
      referencia = await require('../src/kalshi-reference').getReference({ symbol: OP.symbol, collect: true });
      if (!referencia.ok) throw new Error(referencia.reason);
      const history = require('../src/reference-history');
      const candles = history.continuas(history.leer(referencia.index), ahora).slice(-600);
      if (ahora >= cache.hasta || !cache.valor) {
        const horizontes = candles.length >= 400 ? await predecirHorizontes({ series: { '1m': candles }, interval: '1m' }) : [];
        cache = { hasta: ahora + 60000, valor: { horizontes,
          fuente: referencia.index + ' / CF Benchmarks vía Kalshi / USD',
          objetivo: 'precio instantáneo; promedio de liquidación aún no validado',
          bloqueoEntradas: candles.length < 400 ? `Recogiendo histórico del índice: ${candles.length}/400 minutos continuos` : 'Validación pendiente del objetivo de liquidación y tarifas por serie',
          muestrasIndice: candles.length }, precio: referencia.price };
      }
      return cache.valor;
    }
    if (ahora < cache.hasta && cache.valor) return cache.valor;

    const series = {};
    for (const tf of seriesNecesarias(OP.interval)) {
      series[tf] = (await getKlines({ symbol: OP.symbol, interval: tf, limit: 400, demo: OP.demo })).candles;
    }
    const velas = series[OP.interval] || series[seriesNecesarias(OP.interval)[0]];
    cache = { hasta: ahora + 120_000, valor: { horizontes: await predecirHorizontes({ series, interval: OP.interval }) }, precio: velas[velas.length - 1].close };
    return cache.valor;
  }

  const bucle = crearBucle({
    obtenerMercados: async () => {
      if (!OP.demo) {
        if (OP.symbol !== 'BTCUSDT' || OP.serie !== 'KXBTCD') throw new Error('Piloto acotado a BTC/KXBTCD hasta validar otros contratos');
        const result = await listarMercados({ serie: OP.serie });
        const ref = await require('../src/kalshi-reference').getReference({ symbol: OP.symbol, collect: true });
        if (!ref.ok) throw new Error(ref.reason);
        // Piloto explícito: 12 strikes próximos al índice y cierre en la próxima hora.
        const now = Date.now();
        result.mercados = result.mercados.filter(m => m.vencimiento - now > 120000 && m.vencimiento - now <= 3600000)
          .sort((a,b) => Math.abs((a.suelo || a.techo) - ref.price) - Math.abs((b.suelo || b.techo) - ref.price)).slice(0,12);
        return result;
      }
      await prediccion();
      return mercadosDemo({ precio: cache.precio, horizontes: cache.valor.horizontes, sesgo: Number(arg('sesgo', 0)), symbol: OP.symbol });
    },
    obtenerPrediccion: prediccion,
    obtenerLiquidacion: OP.demo ? null : liquidacion,
    supervisar: evidencia ? () => evidencia.resolver(liquidacion) : null,
    observar: evidencia ? data => evidencia.observar({ ...data, referencia }) : null,
    refrescarMercado: OP.demo ? null : async m => {
      if (!m.tipo) m = (await require('../src/kalshi-mercados').verMercado({ ticker: m.ticker })).leido;
      if (!m) throw new Error('Mercado cerrado');
      return book.aplicar(m, await book.obtener(m.ticker));
    },
    obtenerPrecio: async () => {
      if (OP.demo) { await prediccion(); return cache.precio; }
      referencia = await require('../src/kalshi-reference').getReference({ symbol: OP.symbol });
      if (!referencia.ok) throw new Error(referencia.reason);
      return referencia.price;
    },
    fuentes,
    capital: OP.capital,
    riesgoActual: (ahora) => {
      const config=require('../src/trading-settings').read();
      const start=new Date(ahora).toISOString().slice(0,10);
      const history=registro.leer();
      if(history.rotas)throw new Error('Registro dañado');
      const pnl=history.entradas.filter(e=>String(e.t).startsWith(start)&&['salida','liquidacion'].includes(e.tipo)).reduce((s,e)=>s+(Number.isFinite(e.pnl)?e.pnl:0),0);
      const maxDailyLoss=config.capital*config.maxDailyLossPct/100;
      return {...config,maxPerTrade:config.maxPerTrade??config.capital,dailyRemaining:Math.max(0,maxDailyLoss+Math.min(0,pnl)),
        blocked:!control.read().botEnabled?'Detención solicitada':config.paused?'Entradas pausadas por el usuario':-pnl>=maxDailyLoss?'Pérdida diaria máxima alcanzada':null};
    },
    cadaMs: OP.cada,
    // El ruido de base que se declaró al aprobar la serie, no el de por
    // defecto: operar con un número distinto del que alguien firmó sería
    // saltarse justo la parte que la aprobación existía para fijar.
    limitesPara: (m) => {
      const base = reglas.ruidoBaseDe(m.ticker);
      return base === null ? {} : { ruidoBase: base };
    },
    alAnotar: (e) => {
      if (e.tipo === 'vuelta') {
        console.log(`[${new Date().toISOString()}] vuelta ${e.vueltas}: ${e.vistos} mercados · ${e.operables} operables · ${e.vetados} vetados · ${e.salidas} salidas`);
      } else if (e.tipo === 'entrada' || e.tipo === 'salida') {
        console.log(`  → ${e.tipo} ${e.ticker} ${e.lado} ×${e.contratos} a ${(e.precio * 100).toFixed(0)}¢ (papel)`);
      } else if (e.tipo === 'fallo') {
        console.error(`  ! fallo ${e.seguidos}: ${e.mensaje}`);
      } else if (e.tipo === 'parada') {
        console.error(`  !! parado: ${e.motivo}`);
      }
    },
  });

  // La cartera de antes de reiniciar: sin esto se creería plano y volvería a
  // «comprar» lo que ya tenía.
  const historial = registro.leer();
  if (historial.rotas) throw new Error('El registro contiene líneas dañadas; revisar antes de reconstruir la cartera.');
  const previas = reconstruir(historial.entradas);
  bucle.estado.pnlRealizado = historial.entradas.reduce((sum, e) => sum + (['salida','liquidacion'].includes(e.tipo) && Number.isFinite(e.pnl) ? e.pnl : 0), 0);
  for (const [k, v] of previas) bucle.estado.posiciones.set(k, v);
  if (previas.size) console.log(`Recuperadas ${previas.size} posiciones de papel del cuaderno.\n`);

  for (const senal of ['SIGINT', 'SIGTERM']) {
    process.on(senal, () => {
      console.log('\nParando. El cuaderno queda en disco; `npm run agente -- autopsia` lo resume.');
      bucle.parar();
      process.exit(0);
    });
  }

  const runtime=require('../src/bot-runtime');
  const heartbeat=()=>runtime.write({running:bucle.estado.corriendo,controlled:true,agentEnabled:control.read().agentEnabled,agentBusy,stopping:!control.read().botEnabled,cycle:bucle.estado.vueltas,symbol:OP.symbol,interval:OP.interval,lastError:bucle.estado.ultimoError,source:cache.valor?.fuente,warmup:cache.valor?.muestrasIndice,entryBlock:cache.valor?.bloqueoEntradas});
  if(!control.read().botEnabled)return;
  bucle.arrancar();
  heartbeat();
  const controlTimer=setInterval(()=>{
    try{
      if(!control.read().botEnabled){
        bucle.parar();heartbeat();
        if(!bucle.estado.ocupado&&!agentBusy){clearInterval(controlTimer);process.exit(0);}
      }
    }catch{bucle.parar();}
  },1000);controlTimer.unref();
  setInterval(()=>{try{heartbeat();}catch{bucle.parar();}},15000).unref();
}

function fallo(mensaje) {
  console.error(mensaje);
  process.exitCode = 1;
}

const COMANDOS = { reglas: cmdReglas, aprobar: cmdAprobar, autopsia: cmdAutopsia, vigilar: cmdVigilar };
const comando = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'vigilar';

if (!COMANDOS[comando]) {
  fallo(`No conozco «${comando}». Hay: ${Object.keys(COMANDOS).join(', ')}.`);
} else {
  COMANDOS[comando]().catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  });
}
