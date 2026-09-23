'use strict';

(function () {

// ¿Acierta el motor de predicción? Esto lo mide.
//
// Un modelo que dice "el 80% de las veces el precio quedará entre A y B" sólo
// vale si, contándolo sobre el histórico, el precio queda ahí el 80% de las
// veces. Ni el 60 —las bandas serían demasiado estrechas y un stop dentro
// saltaría constantemente— ni el 95 —serían tan anchas que no dirían nada—.
// Eso es la CALIBRACIÓN, y es lo que casi ningún indicador comprueba.
//
// Cómo se mide, y por qué así:
//
//   · **Walk-forward estricto.** En cada instante del pasado se ajusta el
//     modelo SÓLO con lo anterior y se predice lo siguiente. Usar la serie
//     entera para ajustar y luego "predecir" dentro de ella da resultados
//     magníficos y falsos: es el error clásico, y aquí no puede pasar porque
//     cada predicción recibe una rebanada cortada en ese punto.
//
//   · **PIT (transformada integral de probabilidad).** Para cada predicción se
//     apunta en qué cuantil de la distribución cayó el valor real. Si el
//     modelo es perfecto, esos números se reparten uniformemente entre 0 y 1.
//     Si se amontonan en los extremos, las bandas son demasiado estrechas; si
//     se amontonan en el centro, demasiado anchas. Dice MÁS que la cobertura
//     porque mira la distribución entera y no dos puntos.
//
//   · **Pérdida pinball.** La medida estándar para cuantiles: penaliza más
//     equivocarse por el lado que importa en cada uno. Sirve para comparar dos
//     modelos con un solo número.
//
//   · **Contra una referencia.** Todo esto se compara con lo trivial:
//     volatilidad constante del histórico y campana de Gauss. Si el motor no
//     le gana, hay que decirlo, y este archivo lo dice.

const F = typeof module !== 'undefined' && module.exports ? require('./forecast') : globalThis.Forecast;
const I = typeof module !== 'undefined' && module.exports ? require('./indicators') : globalThis.Indicators;
const { quantile } = I;

// Mínimo de historia antes de la primera predicción. Por debajo de esto el
// modelo estaría opinando sobre nada.
const CALENTAMIENTO = 150;

// Cuantil de la normal, para la referencia. Aproximación de Acklam, sobra de
// precisa para lo que se usa.
function zNormal(p) {
  if (p <= 0 || p >= 1) return p <= 0 ? -Infinity : Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.3577518672690, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;

  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) return -zNormal(1 - p);

  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
         (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// La referencia a batir: paseo aleatorio con la volatilidad de toda la
// historia disponible y colas normales. Es lo que haría cualquiera sin modelo.
function referencia(candles, { bloques, cuantiles }) {
  const rets = F.rendimientos(candles).filter(Number.isFinite);
  if (rets.length < 30) return null;

  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sigma = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1)) * Math.sqrt(bloques);
  const p0 = candles[candles.length - 1].close;

  return { precio: p0, sigmaHorizonte: sigma, bandas: cuantiles.map((q) => ({ q, price: p0 * Math.exp(zNormal(q) * sigma) })) };
}

// En qué cuantil de la predicción cayó lo que pasó de verdad.
function pit(bandas, real) {
  // Las bandas vienen ordenadas por cuantil. Se busca dónde encaja.
  let debajo = 0;
  for (const b of bandas) if (real > b.price) debajo = b.q;
  // Entre el cuantil superado y el siguiente; se toma el punto medio para no
  // sesgar sistemáticamente hacia abajo.
  const siguiente = bandas.find((b) => b.price >= real);
  return siguiente ? (debajo + siguiente.q) / 2 : 1;
}

// Pérdida pinball de un cuantil: castiga asimétricamente, que es el sentido de
// predecir un cuantil y no una media.
function pinball(prediccion, real, q) {
  const e = real - prediccion;
  return e >= 0 ? q * e : (q - 1) * e;
}

/**
 * Backtest walk-forward del motor contra la referencia.
 *
 * @param candles   histórico completo
 * @param opciones  { bloques, paso, cuantiles, calentamiento }
 */
function calibrar(candles, { bloques = 1, paso = 1, cuantiles = F.CUANTILES, calentamiento = CALENTAMIENTO } = {}) {
  if (!Array.isArray(candles) || candles.length < calentamiento + bloques + 20) {
    return { ok: false, reason: `hacen falta al menos ${calentamiento + bloques + 20} velas y hay ${Array.isArray(candles) ? candles.length : 0}` };
  }

  const pits = [];
  const pitsRef = [];
  let perdida = 0;
  let perdidaRef = 0;
  let n = 0;

  // Cobertura de los intervalos centrales que se publican.
  const intervalos = [[0.05, 0.95], [0.1, 0.9], [0.25, 0.75]];
  const dentro = intervalos.map(() => 0);
  const dentroRef = intervalos.map(() => 0);

  for (let t = calentamiento; t + bloques < candles.length; t += paso) {
    // SÓLO lo anterior: aquí es donde un backtest se vuelve honesto o mentira.
    const historia = candles.slice(0, t + 1);
    const real = candles[t + bloques].close;
    if (!(real > 0)) continue;

    const f = F.predecir(historia, { bloques, cuantiles, conRejilla: false });
    if (!f.ok) continue;
    const r = referencia(historia, { bloques, cuantiles });
    if (!r) continue;

    pits.push(pit(f.bandas, real));
    pitsRef.push(pit(r.bandas, real));

    for (const b of f.bandas) perdida += pinball(b.price, real, b.q);
    for (const b of r.bandas) perdidaRef += pinball(b.price, real, b.q);

    intervalos.forEach(([lo, hi], i) => {
      const a = f.bandas.find((b) => b.q === lo);
      const z = f.bandas.find((b) => b.q === hi);
      if (a && z && real >= a.price && real <= z.price) dentro[i]++;

      const ar = r.bandas.find((b) => b.q === lo);
      const zr = r.bandas.find((b) => b.q === hi);
      if (ar && zr && real >= ar.price && real <= zr.price) dentroRef[i]++;
    });

    n++;
  }

  if (n < 30) return { ok: false, reason: `sólo ${n} predicciones comprobables; hacen falta 30` };

  return {
    ok: true,
    bloques,
    predicciones: n,
    cobertura: intervalos.map(([lo, hi], i) => ({
      // Redondeado a propósito: 0,95 − 0,05 da 0,8999999999999999 y quien
      // busque la banda del 90% comparando por igualdad no la encuentra.
      nominal: Math.round((hi - lo) * 100) / 100,
      observada: dentro[i] / n,
      referencia: dentroRef[i] / n,
      etiqueta: `${Math.round((hi - lo) * 100)}%`,
    })),
    // Lo ideal es 0: mide cuánto se aparta el reparto de los PIT del uniforme.
    desviacionPit: desviacionUniforme(pits),
    desviacionPitReferencia: desviacionUniforme(pitsRef),
    pinball: perdida / n,
    pinballReferencia: perdidaRef / n,
    // Cuánto mejor es el motor que lo trivial. Negativo significa PEOR.
    mejora: (perdidaRef - perdida) / perdidaRef,
  };
}

// Cuánto se aparta una muestra de PIT del reparto uniforme: media de las
// diferencias absolutas entre la frecuencia observada de cada décima y 0,1.
// Cero es perfecto.
function desviacionUniforme(pits) {
  if (!pits.length) return null;
  const cubos = new Array(10).fill(0);
  for (const p of pits) cubos[Math.min(9, Math.max(0, Math.floor(p * 10)))]++;
  return cubos.reduce((a, c) => a + Math.abs(c / pits.length - 0.1), 0) / 10;
}

// El veredicto en una frase, que es lo que hay que leer.
function veredicto(cal) {
  if (!cal || !cal.ok) return cal ? cal.reason : 'sin calibración';

  const peor = cal.cobertura.reduce((a, c) => Math.max(a, Math.abs(c.observada - c.nominal)), 0);
  const estrecha = cal.cobertura.some((c) => c.observada < c.nominal - 0.05);

  const calidad = peor < 0.03
    ? 'bien calibrado'
    : peor < 0.07
      ? 'aceptable'
      : estrecha
        ? 'MAL: las bandas son demasiado estrechas y el precio se sale más de lo que dicen'
        : 'MAL: las bandas son demasiado anchas y no dicen gran cosa';

  const contra = cal.mejora > 0.02
    ? `mejora un ${(cal.mejora * 100).toFixed(1)}% sobre el paseo aleatorio con campana`
    : cal.mejora < -0.02
      ? `PEOR que el paseo aleatorio con campana en un ${(-cal.mejora * 100).toFixed(1)}%`
      : 'empata con el paseo aleatorio con campana';

  return `${calidad}; ${contra} (${cal.predicciones} predicciones comprobadas).`;
}

const API = { calibrar, veredicto, pit, pinball, zNormal, referencia, desviacionUniforme, CALENTAMIENTO };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else globalThis.Calibracion = API;
})();
