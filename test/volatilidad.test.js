'use strict';

// Volatilidad realizada.
//
// Lo que se fija aquí, además de la aritmética, es la honestidad de la
// medida: esto NO es un índice de volatilidad implícita como el VIX o el de
// CF Benchmarks. Aquéllos salen del precio de las opciones y dicen lo que el
// mercado paga hoy por cubrirse del mes que viene; esto mira al pasado.
// Confundirlos es fácil y caro, así que el aviso viaja con el número.

const test = require('node:test');
const assert = require('node:assert');

const V = require('../src/volatilidad');

// Velas con una volatilidad por paso conocida, para poder comprobar la cuenta.
function velas(n, { paso, base = 100, semilla = 1 }) {
  const out = [];
  let p = base;
  let s = semilla;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;

  for (let i = 0; i < n; i++) {
    p *= Math.exp(rnd() * paso);
    out.push({ openTime: i * 3_600_000, open: p, high: p * 1.001, low: p * 0.999, close: p, volume: 100 });
  }
  return out;
}

test('la desviación típica usa el divisor de muestra, no el de población', () => {
  // Con [2,4,4,4,5,5,7,9] la poblacional es 2 y la muestral 2,138…
  const s = V.desviacion([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.ok(Math.abs(s - 2.13809) < 0.001, `salió ${s}`);
  assert.equal(V.desviacion([5]), null, 'con un solo valor no hay dispersión');
  assert.equal(V.desviacion([]), null);
});

test('los rendimientos son logarítmicos y se saltan los precios imposibles', () => {
  const r = V.rendimientos([{ close: 100 }, { close: 110 }, { close: 0 }, { close: 121 }]);

  // Un cierre en cero se lleva por delante DOS rendimientos: el que entra en
  // él y el que sale. Es lo correcto —no se puede inventar el tramo— y por eso
  // queda uno solo de los tres pares.
  assert.equal(r.length, 1);
  assert.ok(Math.abs(r[0] - Math.log(1.1)) < 1e-12);

  // Sin huecos, n cierres dan n-1 rendimientos.
  assert.equal(V.rendimientos([{ close: 100 }, { close: 110 }, { close: 121 }]).length, 2);
});

test('anualizar escala por la raíz del número de velas del año', () => {
  // Con una desviación por vela conocida, la anual es esa por raíz de 8760.
  const serie = velas(500, { paso: 0.01 });
  const porVela = V.desviacion(V.rendimientos(serie));
  const anual = V.anualizada(serie, '1h');
  assert.ok(Math.abs(anual - porVela * Math.sqrt(8760)) < 1e-9);

  // Y el mismo movimiento en velas más largas da MÁS volatilidad anual,
  // porque cada paso cubre más tiempo.
  assert.ok(V.anualizada(serie, '1d') < V.anualizada(serie, '1h'), 'un día al año va 365 veces, una hora 8760');
});

test('un timeframe que no sabemos anualizar devuelve null, no un número inventado', () => {
  assert.equal(V.anualizada(velas(100, { paso: 0.01 }), '7s'), null);
  const r = V.medir(velas(100, { paso: 0.01 }), '7s');
  assert.equal(r.ok, false);
  assert.match(r.reason, /anualizar/);
});

test('sin velas suficientes se dice cuántas faltan', () => {
  const r = V.medir(velas(10, { paso: 0.01 }), '1h');
  assert.equal(r.ok, false);
  assert.match(r.reason, /al menos 32 velas y hay 10/);
});

test('el percentil sitúa la volatilidad actual en su propio histórico', () => {
  // Tramo tranquilo y final agitado: la de ahora tiene que salir arriba.
  const tranquilo = velas(260, { paso: 0.001 });
  const agitado = velas(40, { paso: 0.02, base: tranquilo[tranquilo.length - 1].close, semilla: 9 });
  const r = V.medir([...tranquilo, ...agitado], '1h');

  assert.equal(r.ok, true);
  assert.ok(r.percentil > 0.9, `debería estar en lo alto, salió ${r.percentil}`);
  assert.equal(r.regimen, 'tensión');
  assert.ok(r.anualizada > r.mediana, 'por encima de su propia mediana');
});

test('y al revés: un final tranquilo tras un tramo agitado es calma', () => {
  const agitado = velas(260, { paso: 0.02 });
  const tranquilo = velas(40, { paso: 0.0005, base: agitado[agitado.length - 1].close, semilla: 3 });
  const r = V.medir([...agitado, ...tranquilo], '1h');

  assert.ok(r.percentil < 0.1, `debería estar abajo, salió ${r.percentil}`);
  assert.equal(r.regimen, 'calma');
});

test('la dispersión entre mercados necesita al menos dos', () => {
  assert.equal(V.dispersion([{ usable: true, price: 100 }]).ok, false);
  assert.equal(V.dispersion([]).ok, false);
  // Y sólo cuenta los utilizables: un mercado caído no es un desacuerdo.
  assert.equal(V.dispersion([{ usable: true, price: 100 }, { usable: false, price: 999 }]).ok, false);
});

test('la dispersión mide el desacuerdo, no el precio', () => {
  const junta = V.dispersion([{ usable: true, price: 100 }, { usable: true, price: 100.01 }, { usable: true, price: 99.99 }]);
  const suelta = V.dispersion([{ usable: true, price: 100 }, { usable: true, price: 105 }, { usable: true, price: 95 }]);

  assert.ok(junta.rangoPct < 0.05);
  assert.ok(suelta.rangoPct > 9);
  assert.equal(junta.mercados, 3);
  // Es relativa, no absoluta: los MISMOS céntimos de desacuerdo sobre un
  // precio diez veces mayor son diez veces menos dispersión. Sin esto no se
  // podría comparar bitcoin con una moneda de un dólar.
  const caro = V.dispersion([{ usable: true, price: 1000 }, { usable: true, price: 1000.01 }, { usable: true, price: 999.99 }]);
  assert.ok(Math.abs(caro.rangoPct - junta.rangoPct / 10) < 1e-9, `${caro.rangoPct} vs ${junta.rangoPct / 10}`);
});

test('el aviso de que NO es volatilidad implícita viaja con el número', () => {
  // Es la confusión fácil y cara: alguien compara este 40% con el VIX.
  assert.match(V.EXPLICACION, /REALIZADA/);
  assert.match(V.EXPLICACION, /VIX/);
  assert.match(V.EXPLICACION, /opciones/);

  const texto = V.describir(V.medir(velas(300, { paso: 0.01 }), '1h'), null);
  assert.match(texto, /realizada/i, 'la frase del panel también lo dice');
});

test('la descripción junta las tres cosas cuando las hay', () => {
  const vol = V.medir(velas(300, { paso: 0.01 }), '1h');
  const disp = V.dispersion([{ usable: true, price: 100 }, { usable: true, price: 100.02 }]);

  const texto = V.describir(vol, disp);
  assert.match(texto, /anual/);
  assert.match(texto, /ventanas anteriores/);
  assert.match(texto, /2 mercados discrepan/);

  // Y sin dispersión no la menciona en vez de poner un hueco.
  assert.doesNotMatch(V.describir(vol, null), /discrepan/);
  assert.equal(V.describir({ ok: false }, disp), null);
});
