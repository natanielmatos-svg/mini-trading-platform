'use strict';

// ¿Cuánto deja entrar ahora y vender dentro de N minutos?
//
// Los modelos del repo predicen el RESULTADO: ¿termina por encima del umbral?
// Esa ventaja sólo se cobra al liquidar. Si se vende antes, se vende a precio
// de mercado, y el precio de mercado no lleva nuestra ventaja dentro: se
// regala, y encima se paga una segunda comisión. Medido sobre 400.000
// contratos simulados, una ventaja del 3% al vencimiento pasa de +2,07¢ a
// −1,14¢ por contrato en cuanto se vende antes de tiempo.
//
// Para que vender pronto gane dinero hay que predecir otra cosa: el PRECIO del
// contrato dentro de un rato. Eso es lo que hay aquí.
//
// El objetivo no es el movimiento del punto medio, que no se puede cobrar, sino
// el neto real de la ida y vuelta:
//
//     yesBid(t+N) − yesAsk(t) − comisión(entrada) − comisión(salida)
//
// Se entra pagando el ask y se sale cobrando el bid, así que la horquilla se
// paga entera y aparece dentro de la etiqueta. Un modelo entrenado contra el
// punto medio aprendería a predecir un beneficio que nadie llega a cobrar.

const { comision } = require('./kalshi-edge');

const VERSION = 'precio-contrato-v1';

// Cada captura del piloto es una rejilla de 30 s. Al emparejar t con t+N se
// admite una captura perdida a cada lado: con menos tolerancia se tiran pares
// buenos, con más se compara contra un precio de otro momento.
const PASO_MS = 30000;
const TOLERANCIA_MS = 45000;

const HORIZONTE_MS = 300000;      // 5 minutos
const MINIMO_ENTRENAMIENTO = 200; // pares antes de ajustar nada

const mid = q => (q.yesBid + q.yesAsk) / 2;
const utilizable = s => s && s.type === 'sample' && s.quoteValid && s.freshBook
  && s.quotes && Number.isFinite(s.quotes.yesBid) && Number.isFinite(s.quotes.yesAsk)
  && Number.isFinite(s.at) && Number.isFinite(s.closesAt);

// El precio de contado observado en la captura, que es lo que sitúa el umbral.
function contado(s) {
  for (const p of s.predictions || []) {
    const x = p.observation && p.observation.price;
    if (Number.isFinite(x) && x > 0) return x;
  }
  return null;
}

// Profundidad del libro a favor y en contra, en los tres mejores niveles. Un
// libro desequilibrado mueve el precio; un libro fino lo mueve más.
function desequilibrio(s) {
  const lado = l => (Array.isArray(l) ? l.slice(0, 3).reduce((a, n) => a + (Number(n && n[1]) || 0), 0) : 0);
  const si = lado(s.book && s.book.yes), no = lado(s.book && s.book.no);
  if (!(si + no > 0)) return null;
  return (si - no) / (si + no);
}

/** Trayectorias por contrato, ordenadas en el tiempo y sin capturas repetidas. */
function rutas(eventos) {
  const porTicker = new Map();
  for (const e of eventos) {
    if (!utilizable(e)) continue;
    if (!porTicker.has(e.ticker)) porTicker.set(e.ticker, new Map());
    // La captura lleva su propia marca de 30 s en el id: si llegan dos de la
    // misma ranura, la segunda es un reintento, no un dato nuevo.
    porTicker.get(e.ticker).set(Math.floor(e.at / PASO_MS), e);
  }
  const salida = new Map();
  for (const [ticker, ranuras] of porTicker) salida.set(ticker, [...ranuras.values()].sort((a, b) => a.at - b.at));
  return salida;
}

function enInstante(ruta, objetivo) {
  let mejor = null, distancia = Infinity;
  for (const s of ruta) {
    const d = Math.abs(s.at - objetivo);
    if (d < distancia) { mejor = s; distancia = d; }
  }
  return distancia <= TOLERANCIA_MS ? mejor : null;
}

// Movimiento del propio contrato: lo que ya se ha movido es la pista más
// directa de lo que puede seguir moviéndose, y no requiere ningún otro dato.
function arrastre(ruta, i, atrasMs) {
  const antes = enInstante(ruta.slice(0, i + 1), ruta[i].at - atrasMs);
  return antes && antes !== ruta[i] ? mid(ruta[i].quotes) - mid(antes.quotes) : null;
}

const CAMPOS = ['ask', 'horquilla', 'restante', 'distancia', 'arrastre60', 'arrastre180', 'desequilibrio'];

function variables(ruta, i) {
  const s = ruta[i], spot = contado(s), dz = desequilibrio(s);
  const a60 = arrastre(ruta, i, 60000), a180 = arrastre(ruta, i, 180000);
  if (!Number.isFinite(spot) || dz == null || a60 == null || a180 == null) return null;
  const restante = (s.closesAt - s.at) / 1000;
  if (!(restante > 0)) return null;
  return [s.quotes.yesAsk, s.quotes.yesAsk - s.quotes.yesBid, restante / 900, 100 * (spot / s.threshold - 1), a60, a180, dz];
}

/**
 * Pares (variables, neto realizado) para entrenar. `horizonteMs` es cuánto se
 * mantiene antes de vender.
 */
function muestras(eventos, { horizonteMs = HORIZONTE_MS } = {}) {
  const fuera = [];
  for (const ruta of rutas(eventos).values()) {
    for (let i = 0; i < ruta.length; i++) {
      const entrada = ruta[i];
      // Vender exige que quede mercado: si el horizonte cae después del cierre,
      // no hay salida posible y el par no existe.
      if (entrada.at + horizonteMs >= entrada.closesAt) continue;
      const salida = enInstante(ruta, entrada.at + horizonteMs);
      if (!salida || salida.at <= entrada.at) continue;
      const x = variables(ruta, i);
      if (!x) continue;
      const ask = entrada.quotes.yesAsk, bid = salida.quotes.yesBid;
      const neto = bid - ask - comision(1, ask) - comision(1, bid);
      fuera.push({ x, y: neto, ticker: entrada.ticker, at: entrada.at, salidaAt: salida.at, ask, bid });
    }
  }
  return fuera.sort((a, b) => a.at - b.at);
}

module.exports = { VERSION, CAMPOS, HORIZONTE_MS, MINIMO_ENTRENAMIENTO, PASO_MS, TOLERANCIA_MS, rutas, muestras, variables, contado, desequilibrio, mid };

// ---------------------------------------------------------------------------
// Ajuste y evaluación
// ---------------------------------------------------------------------------

function resolver(a, b) {
  const n = b.length;
  for (let k = 0; k < n; k++) {
    let pivote = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(a[i][k]) > Math.abs(a[pivote][k])) pivote = i;
    [a[k], a[pivote]] = [a[pivote], a[k]];
    [b[k], b[pivote]] = [b[pivote], b[k]];
    if (Math.abs(a[k][k]) < 1e-12) return null;
    for (let i = k + 1; i < n; i++) {
      const f = a[i][k] / a[k][k];
      for (let j = k; j < n; j++) a[i][j] -= f * a[k][j];
      b[i] -= f * b[k];
    }
  }
  const x = Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < n; j++) s -= a[i][j] * x[j];
    x[i] = s / a[i][i];
  }
  return x.every(Number.isFinite) ? x : null;
}

/** Regresión ridge sobre variables tipificadas. */
function ajustar(muestras, { lambda = 1 } = {}) {
  if (muestras.length < 2) return null;
  const d = muestras[0].x.length, n = muestras.length;
  const medias = Array.from({ length: d }, (_, j) => muestras.reduce((s, m) => s + m.x[j], 0) / n);
  const escalas = Array.from({ length: d }, (_, j) =>
    Math.sqrt(muestras.reduce((s, m) => s + (m.x[j] - medias[j]) ** 2, 0) / n) || 1);
  const diseno = x => [1, ...x.map((v, j) => (v - medias[j]) / escalas[j])];

  const dim = d + 1;
  const a = Array.from({ length: dim }, () => Array(dim).fill(0)), b = Array(dim).fill(0);
  for (const m of muestras) {
    const z = diseno(m.x);
    for (let i = 0; i < dim; i++) { for (let j = 0; j < dim; j++) a[i][j] += z[i] * z[j]; b[i] += z[i] * m.y; }
  }
  // Penaliza las pendientes, no la constante: encoger la media hacia cero
  // sesgaría todas las predicciones al alza.
  for (let i = 1; i < dim; i++) a[i][i] += lambda;
  const pesos = resolver(a, b);
  if (!pesos) return null;
  return { version: VERSION, medias, escalas, pesos, n, predecir: x => diseno(x).reduce((s, v, i) => s + v * pesos[i], 0) };
}

/**
 * Evaluación caminando hacia adelante. Para cada muestra sólo se entrena con
 * pares cuya VENTA ya había ocurrido antes de esta entrada: usar un par que
 * todavía estaba abierto sería entrenar con el futuro.
 */
function caminar(muestras, { minimo = MINIMO_ENTRENAMIENTO, cadaCuantas = 50, lambda = 1 } = {}) {
  const predicciones = [];
  let modelo = null, ajustadoEn = -Infinity;
  for (const m of muestras) {
    const disponibles = muestras.filter(p => p.salidaAt < m.at);
    if (disponibles.length >= minimo && (!modelo || disponibles.length - ajustadoEn >= cadaCuantas)) {
      const nuevo = ajustar(disponibles, { lambda });
      if (nuevo) { modelo = nuevo; ajustadoEn = disponibles.length; }
    }
    if (!modelo) continue;
    predicciones.push({ ...m, prediccion: modelo.predecir(m.x), entrenamiento: modelo.n });
  }
  return predicciones;
}

/** Qué pasa si se opera sólo cuando el modelo promete más de `umbral`. */
function rendimiento(predicciones, umbral = 0) {
  const operadas = predicciones.filter(p => p.prediccion > umbral);
  if (!operadas.length) return { umbral, operaciones: 0, neto: 0, media: null, aciertos: 0, desv: null };
  const neto = operadas.reduce((s, p) => s + p.y, 0);
  const media = neto / operadas.length;
  const varianza = operadas.reduce((s, p) => s + (p.y - media) ** 2, 0) / operadas.length;
  return {
    umbral, operaciones: operadas.length, neto, media,
    aciertos: operadas.filter(p => p.y > 0).length,
    desv: Math.sqrt(varianza),
    error: Math.sqrt(varianza / operadas.length),
  };
}

module.exports.ajustar = ajustar;
module.exports.caminar = caminar;
module.exports.rendimiento = rendimiento;
