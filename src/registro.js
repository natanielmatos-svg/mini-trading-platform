'use strict';

// El cuaderno de bitácora: toda decisión, se opere o no.
//
// Se escriben también —sobre todo— los RECHAZOS. Un registro que sólo anota lo
// que se operó no sirve para la autopsia: la pregunta interesante casi siempre
// es «¿qué dejé pasar, y tenía razón al dejarlo pasar?». Sin esa mitad no se
// puede saber si los filtros están demasiado apretados o demasiado flojos.
//
// Formato JSONL: una línea por decisión, se añade al final y nunca se reescribe.
// Un proceso que lleva días corriendo no puede permitirse reescribir un archivo
// entero, y un archivo que sólo crece por el final sobrevive a que lo maten a
// mitad de escritura: se pierde la última línea, no el histórico.

const fs = require('node:fs');
const path = require('node:path');

const RUTA = process.env.KALSHI_REGISTRO || path.join(process.cwd(), 'datos', 'decisiones.jsonl');

function asegurarCarpeta(ruta) {
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
}

/**
 * Anota una decisión.
 *
 * Nunca lanza. Un fallo al escribir el cuaderno no puede tumbar el bucle que
 * lleva tres días corriendo, pero tampoco puede pasar desapercibido: se avisa
 * por la salida de error y se sigue.
 */
function anotar(entrada, { ruta = RUTA } = {}) {
  const linea = JSON.stringify({ t: new Date().toISOString(), ...entrada });
  try {
    asegurarCarpeta(ruta);
    fs.appendFileSync(ruta, linea + '\n');
    return true;
  } catch (err) {
    console.error(`[registro] no se pudo anotar: ${err.message}`);
    return false;
  }
}

/**
 * Lee el cuaderno.
 *
 * Una línea rota se salta y se cuenta, en vez de tirar la lectura entera: si el
 * proceso murió a mitad de escritura, lo que hay antes sigue valiendo.
 */
function leer({ ruta = RUTA, desde = null } = {}) {
  let crudo;
  try {
    crudo = fs.readFileSync(ruta, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { entradas: [], rotas: 0 };
    throw err;
  }

  const entradas = [];
  let rotas = 0;

  for (const linea of crudo.split('\n')) {
    if (!linea.trim()) continue;
    try {
      const e = JSON.parse(linea);
      if (desde && e.t < desde) continue;
      entradas.push(e);
    } catch {
      rotas++;
    }
  }

  return { entradas, rotas };
}

/**
 * El resumen que se le da al agente para la autopsia, y a una persona para
 * echarle un ojo.
 *
 * Los motivos de rechazo van contados y ordenados: si el 90% de los descartes
 * son por calibración, eso es lo que hay que mirar, y se ve de un vistazo.
 */
function resumir(entradas) {
  const decisiones = entradas.filter((e) => e.tipo === 'decision');
  const operadas = decisiones.filter((e) => e.operar);
  const vetadas = decisiones.filter((e) => e.vetado);

  const motivos = new Map();
  for (const e of decisiones) {
    if (e.operar) continue;
    const clave = clasificar(e.motivo);
    motivos.set(clave, (motivos.get(clave) || 0) + 1);
  }

  return {
    desde: entradas.length ? entradas[0].t : null,
    hasta: entradas.length ? entradas[entradas.length - 1].t : null,
    vistas: decisiones.length,
    operables: operadas.length,
    vetadas: vetadas.length,
    evTotal: Number(operadas.reduce((a, e) => a + (e.evTotal || 0), 0).toFixed(2)),
    costeTotal: Number(operadas.reduce((a, e) => a + (e.coste || 0), 0).toFixed(2)),
    motivos: [...motivos.entries()].sort((a, b) => b[1] - a[1]).map(([motivo, veces]) => ({ motivo, veces })),
  };
}

// Los motivos llevan números dentro («ventaja neta de 0.8¢…»), así que contar
// cadenas exactas daría un motivo distinto por mercado. Se agrupan por familia.
function clasificar(motivo) {
  const m = String(motivo || 'sin motivo');
  if (/calibrad/.test(m)) return 'plazo no calibrado';
  if (/ventaja neta/.test(m)) return 'ventaja por debajo del mínimo';
  if (/horquilla/.test(m)) return 'horquilla demasiado ancha';
  if (/muestra medida/.test(m)) return 'strike fuera de la muestra';
  if (/no cuadran/.test(m)) return 'libro descuadrado';
  if (/vetado/.test(m)) return 'vetado';
  if (/vence|plazo más corto|medido/.test(m)) return 'plazo fuera de rango';
  if (/comisión|redondeo/.test(m)) return 'contrato casi resuelto';
  return m.slice(0, 60);
}

module.exports = { anotar, leer, resumir, clasificar, RUTA };
