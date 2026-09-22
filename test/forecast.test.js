'use strict';

// El motor de predicción y su calibración.
//
// Lo que más importa aquí no es que la aritmética salga: es que el motor NO
// haga las dos cosas que lo convertirían en una máquina de fabricar confianza
// falsa. Una, predecir dirección. Dos, prometer bandas que no cumple.

const test = require('node:test');
const assert = require('node:assert');

const F = require('../src/forecast');
const C = require('../src/calibracion');

// Serie con volatilidad que se agrupa y saltos, que es lo que tienen los
// precios de verdad y lo que hace fallar a la campana de Gauss.
function serie(n, semilla, { salto = 0.01 } = {}) {
  let s = semilla;
  let p = 86000;
  let v = 0.003;
  const u = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const g = () => { const a = Math.max(u(), 1e-9); const b = u(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b); };

  const out = [];
  for (let i = 0; i < n; i++) {
    v = Math.sqrt(0.000002 + 0.1 * (v * g()) ** 2 + 0.88 * v * v);
    let r = v * g();
    if (u() < salto) r += (u() < 0.5 ? -1 : 1) * v * 6;
    p *= Math.exp(r);
    out.push({ openTime: i * 3_600_000, open: p, high: p * 1.001, low: p * 0.999, close: p, volume: 100 });
  }
  return out;
}

// --- Lo que el motor NO debe hacer -----------------------------------------

test('la banda central es el precio de ahora, a cualquier horizonte', () => {
  // La regla que sostiene todo lo demás: no se predice dirección. Si la
  // mediana se separase del precio actual, el motor estaría apostando, y a
  // estos plazos la deriva es indistinguible del ruido.
  const velas = serie(500, 4242);
  const ultimo = velas[velas.length - 1].close;

  for (const bloques of [1, 4, 24, 96]) {
    const f = F.predecir(velas, { bloques });
    assert.equal(f.ok, true, f.reason);
    const mediana = f.bandas.find((b) => b.q === 0.5).price;
    assert.ok(Math.abs(mediana / ultimo - 1) < 1e-9, `bloques ${bloques}: mediana ${mediana} vs ${ultimo}`);
    assert.equal(f.deriva, 0);
  }
});

test('ni siquiera la corrección conforme mete dirección', () => {
  // Es la puerta de atrás: unos errores de entrenamiento con tendencia
  // meterían esa tendencia en el cuantil 50. Pasó, y por eso se centran.
  const subiendo = serie(700, 99).map((c, i) => {
    const factor = 1 + i * 0.0004; // tendencia fuerte y sostenida
    return { ...c, open: c.open * factor, high: c.high * factor, low: c.low * factor, close: c.close * factor };
  });

  const conf = F.cuantilesConformes(subiendo, { bloques: 4 });
  assert.ok(conf, 'con 700 velas tiene que haber conformes');

  const f = F.predecir(subiendo, { bloques: 4, conformes: conf });
  const mediana = f.bandas.find((b) => b.q === 0.5).price;
  assert.ok(
    Math.abs(mediana / subiendo[subiendo.length - 1].close - 1) < 1e-9,
    'la tendencia del entrenamiento no puede desplazar la banda central'
  );
});

test('sin historia suficiente no se predice, se dice por qué', () => {
  const r = F.predecir(serie(40, 1), { bloques: 1 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /al menos 100 velas/);
  assert.equal(F.cuantilesConformes(serie(100, 1), { bloques: 1 }), null, 'ni conformes con poca historia');
});

// --- Las bandas -------------------------------------------------------------

test('las bandas están ordenadas y se ensanchan con el horizonte', () => {
  const velas = serie(600, 7);
  let anchoPrevio = 0;

  for (const bloques of [1, 4, 12, 48]) {
    const f = F.predecir(velas, { bloques });
    const precios = f.bandas.map((b) => b.price);

    for (let i = 1; i < precios.length; i++) {
      assert.ok(precios[i] >= precios[i - 1], `bloques ${bloques}: cuantiles desordenados`);
    }
    const ancho = f.bandas.find((b) => b.q === 0.95).price - f.bandas.find((b) => b.q === 0.05).price;
    assert.ok(ancho > anchoPrevio, `bloques ${bloques}: no se ensancha (${ancho} vs ${anchoPrevio})`);
    anchoPrevio = ancho;
  }
});

test('con la volatilidad de ahora baja, el horizonte se ensancha más que la raíz del tiempo', () => {
  // Es la corrección por reversión a la media. Escalar por raíz de h daba
  // bandas demasiado estrechas a plazos largos: la banda del 90% contenía el
  // 83,6% a doce velas, medido.
  const vLargo = 0.0004;

  const baja = F.varianzaHorizonte(0.005, vLargo, 12, 0.97);
  const alta = F.varianzaHorizonte(0.05, vLargo, 12, 0.97);

  assert.ok(Math.sqrt(baja) > 0.005 * Math.sqrt(12), 'con vol baja tiene que ensanchar');
  assert.ok(Math.sqrt(alta) < 0.05 * Math.sqrt(12), 'con vol alta tiene que estrechar');

  // Y con persistencia 1 —sin reversión— se reduce EXACTAMENTE a la raíz del
  // tiempo: la corrección no cambia el caso de siempre, lo generaliza.
  assert.ok(Math.abs(Math.sqrt(F.varianzaHorizonte(0.01, vLargo, 12, 1)) - 0.01 * Math.sqrt(12)) < 1e-12);
});

test('la volatilidad condicional reacciona a lo reciente', () => {
  // Una desviación típica normal pesa igual ayer que hace un mes. La EWMA no,
  // y por eso detecta que el régimen ha cambiado.
  const tranquila = serie(400, 5, { salto: 0 });
  const sigmas = F.ewmaSigma(F.rendimientos(tranquila));

  assert.equal(sigmas.length, F.rendimientos(tranquila).length + 1, 'una sigma más: la del paso que aún no ha pasado');
  assert.ok(sigmas.every((s) => s > 0));
});

test('los estandarizados se centran: la mediana de la muestra no es deriva', () => {
  const rets = [0.01, 0.02, -0.01, 0.015, 0.005, 0.03, -0.02, 0.01];
  const sigmas = new Array(rets.length + 1).fill(0.01);
  const z = F.estandarizados(rets, sigmas);

  const orden = [...z].sort((a, b) => a - b);
  const m = orden.length % 2 ? orden[(orden.length - 1) / 2] : (orden[orden.length / 2 - 1] + orden[orden.length / 2]) / 2;
  assert.ok(Math.abs(m) < 1e-12, `la mediana debería ser cero y es ${m}`);

  // Sin centrar, conserva la mediana original.
  const sinCentrar = F.estandarizados(rets, sigmas, { centrar: false });
  assert.ok(sinCentrar.some((x, i) => x !== z[i]), 'centrar tiene que cambiar algo');
});

// --- Calibración ------------------------------------------------------------

test('el backtest es estrictamente causal', () => {
  // Si se colara información del futuro, la calibración saldría perfecta y
  // sería mentira. Se comprueba con una serie que cambia de régimen de golpe:
  // un modelo que mirase el futuro no se sorprendería, y éste tiene que
  // sorprenderse.
  const tranquilo = serie(600, 3, { salto: 0 });
  const base = tranquilo[tranquilo.length - 1].close;
  const agitado = serie(300, 8, { salto: 0.05 }).map((c) => {
    const k = base / 86000;
    return { ...c, open: c.open * k, high: c.high * k, low: c.low * k, close: c.close * k };
  });

  const cal = C.calibrar([...tranquilo, ...agitado], { bloques: 1 });
  assert.equal(cal.ok, true, cal.reason);
  assert.ok(cal.predicciones > 100);
  // Con un cambio de régimen brusco, la cobertura NO puede ser perfecta.
  const c90 = cal.cobertura.find((c) => c.nominal === 0.9);
  assert.ok(c90.observada < 0.99, 'una cobertura del 99% delataría que mira el futuro');
});

test('la cobertura nominal viene redondeada y se puede buscar por igualdad', () => {
  // 0,95 − 0,05 da 0,8999999999999999 y quien busque la banda del 90% no la
  // encuentra. Pasó.
  const cal = C.calibrar(serie(600, 11), { bloques: 1 });
  assert.ok(cal.cobertura.find((c) => c.nominal === 0.9), 'la del 90% tiene que encontrarse');
  assert.ok(cal.cobertura.find((c) => c.nominal === 0.8));
  assert.ok(cal.cobertura.find((c) => c.nominal === 0.5));
});

test('el veredicto denuncia unas bandas demasiado estrechas', () => {
  // No sirve un informe que diga "aceptable" pase lo que pase: el caso malo
  // tiene que decirse con todas las letras.
  const estrecho = {
    ok: true, predicciones: 500, mejora: 0,
    cobertura: [{ nominal: 0.9, observada: 0.72, referencia: 0.85, etiqueta: '90%' }],
  };
  assert.match(C.veredicto(estrecho), /MAL/);
  assert.match(C.veredicto(estrecho), /estrechas/);

  const ancho = { ...estrecho, cobertura: [{ nominal: 0.5, observada: 0.92, referencia: 0.6, etiqueta: '50%' }] };
  assert.match(C.veredicto(ancho), /anchas/);

  const bueno = { ...estrecho, cobertura: [{ nominal: 0.9, observada: 0.902, referencia: 0.85, etiqueta: '90%' }], mejora: 0.1 };
  assert.match(C.veredicto(bueno), /bien calibrado/);
  assert.match(C.veredicto(bueno), /mejora un 10/);
});

test('el veredicto dice cuándo el motor es PEOR que lo trivial', () => {
  // Es la comparación que nadie publica: si no le gana al paseo aleatorio con
  // campana, hay que decirlo.
  const peor = {
    ok: true, predicciones: 500, mejora: -0.15,
    cobertura: [{ nominal: 0.9, observada: 0.9, referencia: 0.9, etiqueta: '90%' }],
  };
  assert.match(C.veredicto(peor), /PEOR que el paseo aleatorio/);
});

test('la normal inversa acierta en los valores de tabla', () => {
  for (const [p, z] of [[0.975, 1.959964], [0.95, 1.644854], [0.5, 0], [0.05, -1.644854], [0.01, -2.326348]]) {
    assert.ok(Math.abs(C.zNormal(p) - z) < 1e-4, `z(${p}) = ${C.zNormal(p)}, esperado ${z}`);
  }
});

test('la pérdida pinball castiga asimétricamente, que es el sentido de un cuantil', () => {
  // En el cuantil 90 quedarse corto debe doler más que pasarse.
  const corto = C.pinball(100, 110, 0.9);
  const pasado = C.pinball(100, 90, 0.9);
  assert.ok(corto > pasado, `corto ${corto} debería doler más que pasado ${pasado}`);

  // En el 10, al revés.
  assert.ok(C.pinball(100, 90, 0.1) > C.pinball(100, 110, 0.1));
  assert.equal(C.pinball(100, 100, 0.5), 0, 'acertar no cuesta nada');
});

test('el aviso de que esto NO predice un precio viaja con el motor', () => {
  assert.match(F.AVISO, /NO predice un precio/);
  assert.match(F.AVISO, /precio de ahora/);
  assert.match(F.AVISO, /calibración/);
});

// --- Horizontes en tiempo, no en bloques del gráfico ------------------------

test('los plazos cortos se calculan con la serie que les corresponde', () => {
  // El fallo de diseño: los horizontes iban en bloques del intervalo elegido,
  // así que con el gráfico en 1h no había forma de preguntar por los próximos
  // cinco minutos, que es justo el plazo en el que alguien mira la pantalla.
  //
  // Y no vale predecir cinco minutos con velas de una hora: sería inventarse
  // una resolución que los datos no tienen.
  const { planDeHorizontes } = F;

  for (const grafico of ['1h', '15m', '1d']) {
    const plan = planDeHorizontes(grafico);

    // Están los cinco plazos cortos, y todos salen de velas de un minuto.
    for (const ms of [60_000, 300_000, 900_000, 1_800_000, 3_600_000]) {
      const h = plan.find((x) => x.ms === ms);
      assert.ok(h, `${grafico}: falta el horizonte de ${ms / 60_000} min`);
      assert.equal(h.interval, '1m', `${grafico}: ${ms / 60_000} min debería salir de velas de 1m`);
    }

    // Ordenados por tiempo y sin duplicados: con el gráfico en 15m, "1 bloque"
    // son 15 minutos y eso ya lo cubre la serie de un minuto con mejor
    // resolución.
    const tiempos = plan.map((x) => x.ms);
    assert.deepEqual(tiempos, [...tiempos].sort((a, b) => a - b), `${grafico}: desordenados`);
    assert.equal(new Set(tiempos).size, tiempos.length, `${grafico}: horizontes duplicados`);
  }
});

test('el gráfico aporta los plazos que la serie de un minuto no cubre', () => {
  const { planDeHorizontes } = F;

  const plan = planDeHorizontes('1h');
  const largos = plan.filter((h) => h.interval === '1h');
  assert.ok(largos.length >= 4, 'tiene que haber plazos largos del propio gráfico');
  // Todos por encima de una hora, que es donde acaba la serie corta.
  for (const h of largos) assert.ok(h.ms > 3_600_000, `${h.ms} ms no debería venir del gráfico`);

  // Con el gráfico en 1 minuto no hay nada que añadir por arriba hasta pasar
  // de la hora.
  for (const h of planDeHorizontes('1m')) {
    assert.ok(h.ms >= 60_000);
  }
});

test('las bandas escalan con la raíz del tiempo sobre datos realistas', () => {
  // En modo demo las bandas salen casi planas entre 1 y 60 minutos, y parece
  // un fallo. No lo es: el generador de demostración es una onda suave, así
  // que un movimiento de una hora NO es ocho veces el de un minuto. Con una
  // serie que se comporta como un precio, sí.
  let s = 12345;
  let p = 86000;
  let v = 0.0004;
  const u = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const g = () => { const a = Math.max(u(), 1e-9); const b = u(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b); };

  const velas = [];
  for (let i = 0; i < 800; i++) {
    v = Math.sqrt(3e-8 + 0.08 * (v * g()) ** 2 + 0.9 * v * v);
    p *= Math.exp(v * g());
    velas.push({ openTime: i * 60_000, open: p, high: p * 1.0002, low: p * 0.9998, close: p, volume: 10 });
  }

  const sigma1 = F.predecir(velas, { bloques: 1 }).sigmaHorizonte;
  const sigma60 = F.predecir(velas, { bloques: 60 }).sigmaHorizonte;
  const ratio = sigma60 / sigma1;

  // Cerca de √60 = 7,75, y por DEBAJO: la reversión a la media descuenta algo
  // cuando la volatilidad de ahora está por encima de la de largo plazo.
  assert.ok(ratio > 6 && ratio < Math.sqrt(60) + 0.1, `ratio ${ratio}, esperado cerca de ${Math.sqrt(60)}`);
});
