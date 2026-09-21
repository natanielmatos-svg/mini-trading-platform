'use strict';

const fs = require('fs');
const path = require('path');

// Registro de oportunidades: cada refresco del catálogo anota las señales que
// el análisis detecta —divergencias entre plataformas y arbitrajes aparentes—
// con su precio y su hora, en un fichero que se va acumulando.
//
// No opera. Sólo anota. Ésa es exactamente su utilidad: cuando el evento
// resuelva sabremos qué habría pasado, y a las pocas semanas tendremos la
// respuesta empírica a la única pregunta que importa antes de arriesgar
// dinero — si el edge que detecta esta app es real o es ruido.
//
// El formato es JSONL (una línea JSON por señal) porque se puede añadir al
// final sin releer el fichero, sobrevive a un corte a mitad de escritura
// perdiendo como mucho la última línea, y se inspecciona con cualquier cosa.

const LEDGER_DIR = process.env.LEDGER_DIR || path.join(__dirname, '..', 'data', 'ledger');
const LEDGER_FILE = path.join(LEDGER_DIR, 'oportunidades.jsonl');

// Cuánta divergencia entre plataformas merece anotarse. Por debajo de esto es
// ruido de mercado: spreads que se mueven, no desacuerdo real.
const DIVERGENCIA_MINIMA = Number(process.env.LEDGER_MIN_DIVERGENCE || 0.05);

function ensureDir() {
  fs.mkdirSync(LEDGER_DIR, { recursive: true });
}

// Una señal por evento y opción, no por refresco: si la misma divergencia sigue
// ahí cinco minutos después no es una oportunidad nueva. Se guarda la primera
// vez que se vio y se actualiza cuánto ha durado.
function claveDe(analysis, option, tipo) {
  return `${tipo}:${analysis.id}:${option ? option.key : '-'}`;
}

function extraerSenales(analysis, ahora) {
  const senales = [];

  // 1. Divergencia: dos plataformas con dinero real discrepan en el precio de
  //    la misma opción. Manifold se excluye por ser dinero de juego.
  for (const option of analysis.options) {
    const reales = option.platforms.filter((p) => p.platform !== 'manifold');
    if (reales.length < 2) continue;

    const probs = reales.map((p) => p.impliedProb).filter(Number.isFinite);
    if (probs.length < 2) continue;

    const min = Math.min(...probs);
    const max = Math.max(...probs);
    if (max - min < DIVERGENCIA_MINIMA) continue;

    const barata = reales.find((p) => p.impliedProb === min);
    const cara = reales.find((p) => p.impliedProb === max);

    senales.push({
      tipo: 'divergencia',
      clave: claveDe(analysis, option, 'divergencia'),
      vistaEn: ahora,
      eventoId: analysis.id,
      titulo: analysis.title,
      url: analysis.url,
      categoria: analysis.category,
      cierraEn: analysis.closesAt,
      matchScore: analysis.matchScore,
      opcion: option.label,
      consenso: option.probability,
      divergencia: max - min,
      // Lo que costaría montar la posición y dónde, para poder comprobar
      // después si el precio estaba realmente disponible.
      comprarEn: barata.platformLabel,
      comprarA: barata.ask,
      venderEn: cara.platformLabel,
      venderA: cara.bid,
      liquidez: Math.min(barata.liquidity || 0, cara.liquidity || 0),
      // El resultado se rellena cuando el evento resuelve.
      resuelto: null,
      acierto: null,
    });
  }

  // 2. Arbitraje: ya viene filtrado por cobertura y por ser de una sola
  //    plataforma, así que aquí sólo se anota.
  if (analysis.arbitrage) {
    senales.push({
      tipo: 'arbitraje',
      clave: claveDe(analysis, null, 'arbitraje'),
      vistaEn: ahora,
      eventoId: analysis.id,
      titulo: analysis.title,
      url: analysis.url,
      categoria: analysis.category,
      cierraEn: analysis.closesAt,
      matchScore: analysis.matchScore,
      plataforma: analysis.arbitrage.platformLabel,
      coste: analysis.arbitrage.cost,
      cobertura: analysis.arbitrage.coverage,
      retorno: analysis.arbitrage.returnPct,
      patas: analysis.arbitrage.legs.length,
      resuelto: null,
      acierto: null,
    });
  }

  return senales;
}

// Claves ya anotadas, para no repetir la misma señal en cada refresco.
let vistas = null;

function cargarVistas() {
  if (vistas) return vistas;
  vistas = new Set();

  if (!fs.existsSync(LEDGER_FILE)) return vistas;

  const contenido = fs.readFileSync(LEDGER_FILE, 'utf8');
  for (const linea of contenido.split('\n')) {
    if (!linea.trim()) continue;
    try {
      const registro = JSON.parse(linea);
      if (registro.clave) vistas.add(registro.clave);
    } catch {
      // Una línea a medias (corte durante la escritura) no invalida el resto.
    }
  }
  return vistas;
}

function registrar(analyses, { ahora = new Date().toISOString() } = {}) {
  ensureDir();
  const yaVistas = cargarVistas();

  const nuevas = [];
  for (const analysis of analyses) {
    for (const senal of extraerSenales(analysis, ahora)) {
      if (yaVistas.has(senal.clave)) continue;
      yaVistas.add(senal.clave);
      nuevas.push(senal);
    }
  }

  if (nuevas.length) {
    fs.appendFileSync(LEDGER_FILE, nuevas.map((s) => JSON.stringify(s)).join('\n') + '\n');
  }

  return { nuevas: nuevas.length, total: yaVistas.size };
}

function leer() {
  if (!fs.existsSync(LEDGER_FILE)) return [];
  return fs
    .readFileSync(LEDGER_FILE, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function resumen() {
  const registros = leer();
  const porTipo = {};
  const porCategoria = {};

  for (const r of registros) {
    porTipo[r.tipo] = (porTipo[r.tipo] || 0) + 1;
    porCategoria[r.categoria] = (porCategoria[r.categoria] || 0) + 1;
  }

  const divergencias = registros.filter((r) => r.tipo === 'divergencia');
  const medias = divergencias.length
    ? divergencias.reduce((acc, r) => acc + r.divergencia, 0) / divergencias.length
    : null;

  return {
    total: registros.length,
    porTipo,
    porCategoria,
    divergenciaMedia: medias,
    primera: registros[0]?.vistaEn || null,
    ultima: registros[registros.length - 1]?.vistaEn || null,
    fichero: LEDGER_FILE,
  };
}

module.exports = { registrar, leer, resumen, extraerSenales, LEDGER_FILE, DIVERGENCIA_MINIMA };
