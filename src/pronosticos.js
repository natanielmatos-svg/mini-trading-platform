'use strict';

// ¿Cómo van los pronósticos del piloto BTC 15m?
//
// La evaluación que `scripts/research-btc15m.js` hacía en línea, extraída aquí
// para que el informe de auditoría y el comando de estado no puedan dar cifras
// distintas sobre los mismos datos.
//
// Se compara cada contrato liquidado contra cuatro lados:
//
//   raw        TimesFM, el cierre neuronal sin corregir
//   candidate  la IA local, ya calibrada
//   last       mantener el último precio observado (referencia tonta)
//   market     el lado que daba Kalshi al pedirlo
//
// Sólo entra la PRIMERA captura elegible de cada contrato: tomar la mejor de
// varias sería elegir después de ver el resultado.

const VENUES = JSON.stringify(['binance', 'coinbase', 'gemini', 'kraken']);
const NOMBRES = ['raw', 'candidate', 'last', 'market'];

// Comisión ilustrativa de Kalshi, 0.07·p·(1−p) al alza. No es la tarifa
// certificada de la cuenta: sirve para no leer el bruto como si fuera neto.
const comisionIlustrativa = coste => Math.ceil((0.07 * coste * (1 - coste) - 1e-12) * 100) / 100;

function evaluar(eventos) {
  const capturas = eventos.filter(e => e.type === 'sample');
  const liquidados = new Map(eventos.filter(e => e.type === 'settlement').map(e => [e.ticker, e.resultado]));

  const primera = new Map();
  for (const e of capturas.filter(e => e.fixedWindowEligible)) if (!primera.has(e.ticker)) primera.set(e.ticker, e);

  const filas = [];
  for (const e of primera.values()) {
    if (!liquidados.has(e.ticker)) continue;
    const p = e.predictions?.find(p => p.source === 'consolidado' && p.unit === 'USD' && JSON.stringify(p.venues) === VENUES);
    if (!p || !Number.isFinite(p.observation?.price)) continue;

    const encima = x => (e.operator === '>=' ? x >= e.threshold : x > e.threshold);
    const lados = {
      raw: encima(p.prediction.raw) ? 'yes' : 'no',
      candidate: encima(p.prediction.candidate) ? 'yes' : 'no',
      last: encima(p.observation.price) ? 'yes' : 'no',
      market: e.quotes.yesBid + e.quotes.yesAsk >= 1 ? 'yes' : 'no',
    };

    const fila = { ticker: e.ticker, at: e.requestedAt, result: liquidados.get(e.ticker), version: p.prediction.version };
    for (const [nombre, lado] of Object.entries(lados)) {
      const coste = e.quotes[lado + 'Ask'], acierto = lado === fila.result;
      fila[nombre] = { side: lado, cost: coste, win: acierto, gross: (acierto ? 1 : 0) - coste, illustrativeFee: comisionIlustrativa(coste) };
    }
    filas.push(fila);
  }

  // Agrupado por versión del modelo: mezclar versiones sumaría aciertos de
  // modelos distintos como si fueran el mismo.
  const grupos = [...new Set(filas.map(r => r.version))].map(version => {
    const rs = filas.filter(r => r.version === version);
    return {
      version,
      n: rs.length,
      strategies: Object.fromEntries(NOMBRES.map(k => [k, {
        wins: rs.filter(r => r[k].win).length,
        gross: rs.reduce((s, r) => s + r[k].gross, 0),
        cost: rs.reduce((s, r) => s + r[k].cost, 0),
        meanCost: rs.length ? rs.reduce((s, r) => s + r[k].cost, 0) / rs.length : null,
        afterIllustrativeFees: rs.reduce((s, r) => s + r[k].gross - r[k].illustrativeFee, 0),
        afterFeesAndOneCentAdverseMove: rs.reduce((s, r) => s + r[k].gross - r[k].illustrativeFee - 0.01, 0),
      }])),
    };
  });

  const cobertura = {
    samples: capturas.length,
    contracts: new Set(capturas.map(s => s.ticker)).size,
    settled: liquidados.size,
    fixedWindowSamples: capturas.filter(s => s.fixedWindowEligible).length,
    evaluated: filas.length,
  };

  return { rows: filas, groups: grupos, coverage: cobertura, names: NOMBRES };
}

module.exports = { evaluar, comisionIlustrativa, NOMBRES };
