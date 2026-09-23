'use strict';

// Los módulos que comparten las dos páginas: el gráfico, el panel de ruptura y
// la tabla multi-timeframe.
//
// Se prueban desde Node, sin navegador, porque las partes que se pueden
// equivocar en silencio son cuentas: la escala de la rejilla, la probabilidad
// recalculada con el precio vivo, el veredicto y la banda neutra de la tabla.
// Lo que sí necesita un navegador —que se pinten píxeles— se comprueba
// aparte, contra el código anterior.

const test = require('node:test');
const assert = require('node:assert');

const Chart = require('../src/chart');
const Ruptura = require('../src/panel-ruptura');
const TablaMtf = require('../src/tabla-mtf');
const { atr } = require('../src/indicators');

// --- Gráfico ---------------------------------------------------------------

test('la rejilla usa escalones redondos', () => {
  // Una rejilla en 1,037 no la lee nadie: sólo 1, 2 y 5 por década.
  for (const [rango, esperado] of [[100, 20], [1000, 200], [0.5, 0.1], [60, 10], [8500, 2000]]) {
    const paso = Chart.niceStep(rango, 6);
    const mantisa = paso / 10 ** Math.floor(Math.log10(paso));
    assert.ok([1, 2, 5, 10].includes(Math.round(mantisa * 1000) / 1000), `paso ${paso} para rango ${rango}`);
    assert.equal(paso, esperado, `rango ${rango}`);
  }
});

test('la geometría reserva sitio para los ejes y el volumen', () => {
  const canvas = { clientWidth: 800, clientHeight: 400 };
  const g = Chart.geometry(canvas);

  assert.equal(g.w, 800);
  assert.equal(g.plotW, 800 - Chart.PAD.left - Chart.PAD.right);
  assert.ok(g.volumeH > 0 && g.volumeH < g.plotH, 'el volumen ocupa menos que el precio');
  // El bloque de volumen empieza donde acaba el de precio.
  assert.ok(g.volumeTop > Chart.PAD.top + g.plotH - 1);
  assert.ok(g.volumeTop + g.volumeH <= 400, 'nada se sale del canvas');
});

test('el eje de tiempo cambia de formato en los marcos largos', () => {
  const ms = Date.UTC(2026, 8, 23, 14, 30);
  assert.match(Chart.fmtTimeAxis(ms, '1h'), /\d{2}:\d{2}/);
  assert.doesNotMatch(Chart.fmtTimeAxis(ms, '1d'), /\d{2}:\d{2}/, 'en diario se enseña la fecha, no la hora');
});

test('la vela bajo el cursor se calcula desde el borde del área de dibujo', () => {
  const canvas = {
    clientWidth: 800, clientHeight: 400,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 400 }),
  };
  const velas = Array.from({ length: 100 }, (_, i) => ({ openTime: i }));

  assert.equal(Chart.indexAt(canvas, Chart.PAD.left + 1, velas), 0);
  assert.equal(Chart.indexAt(canvas, Chart.PAD.left - 5, velas), null, 'a la izquierda del área no hay vela');
  assert.equal(Chart.indexAt(canvas, 795, velas), null, 'sobre el eje de precios tampoco');

  const medio = Chart.indexAt(canvas, Chart.PAD.left + Chart.geometry(canvas).plotW / 2, velas);
  assert.equal(medio, 50);
});

// --- Panel de ruptura ------------------------------------------------------

// Una muestra de excursiones como la que manda el servidor: la mitad de las
// velas recorrieron al menos 0,5 ATR, una de cada diez al menos 2.
const MUESTRA = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.9, 1.4, 2.2];

test('la probabilidad en vivo baja al alejarse el precio del nivel', () => {
  const side = { direction: 'alza', level: 100, touches: 2 };
  const cerca = Ruptura.liveSide(side, MUESTRA, 99.5, 1, 1);
  const lejos = Ruptura.liveSide(side, MUESTRA, 97, 1, 1);

  assert.ok(cerca.probability > lejos.probability);
  assert.equal(cerca.distance, 0.5);
  assert.equal(cerca.distanceAtr, 0.5);
  assert.ok(cerca.distancePct > 0);
});

test('quedando poca vela hace falta más recorrido para lo mismo', () => {
  const side = { direction: 'alza', level: 100, touches: 1 };
  const enteraP = Ruptura.liveSide(side, MUESTRA, 99, 1, 1);
  const finalP = Ruptura.liveSide(side, MUESTRA, 99, 1, 0.1);

  assert.ok(finalP.requiredAtr > enteraP.requiredAtr, 'el escalado por tiempo exige más');
  assert.ok(finalP.probability <= enteraP.probability);
  // Y se guarda la cuenta sin descontar tiempo, para poder decirlo.
  assert.equal(finalP.probabilityFullCandle, enteraP.probability);
});

test('un nivel ya pasado se marca como superado, no como 100% seguro', () => {
  const up = Ruptura.liveSide({ direction: 'alza', level: 100 }, MUESTRA, 101, 1, 0.5);
  assert.equal(up.broken, true);
  assert.equal(up.distance, 0);

  const down = Ruptura.liveSide({ direction: 'baja', level: 100 }, MUESTRA, 99, 1, 0.5);
  assert.equal(down.broken, true);
});

test('sin ATR utilizable no se inventa una probabilidad', () => {
  assert.equal(Ruptura.liveSide({ direction: 'alza', level: 100 }, MUESTRA, 99, 0, 1), null);
  assert.equal(Ruptura.liveSide({ direction: 'alza', level: 100 }, MUESTRA, 99, NaN, 1), null);
  assert.equal(Ruptura.liveSide(null, MUESTRA, 99, 1, 1), null);
});

test('el veredicto distingue "lejos de todo" de "no le da tiempo"', () => {
  const nada = { probability: 0.01 };
  assert.match(Ruptura.verdictFor(nada, nada, 0.9).text, /lejos de los dos niveles/);
  assert.match(Ruptura.verdictFor(nada, nada, 0.1).text, /no le da tiempo/);

  // Y el empate no es lo mismo que ninguno de los dos.
  const empate = Ruptura.verdictFor({ probability: 0.4 }, { probability: 0.42 }, 0.8);
  assert.match(empate.text, /equilibrio/);
  assert.equal(empate.cls, 'flat');

  assert.equal(Ruptura.verdictFor({ probability: 0.6 }, { probability: 0.2 }, 0.8).cls, 'bull');
  assert.equal(Ruptura.verdictFor({ probability: 0.2 }, { probability: 0.6 }, 0.8).cls, 'bear');
  assert.equal(Ruptura.verdictFor(null, null, 0.8).cls, 'flat');
});

test('el detalle del lado dice cuántos toques y si el nivel es del extremo', () => {
  const html = Ruptura.sideHtml(
    { probability: 0.3, level: 100, distancePct: 1.2, distanceAtr: 0.8, touches: 1, fallback: true, remaining: 0.9 },
    'Ruptura al alza', 'up'
  );
  assert.match(html, /1 toque\b/, 'en singular cuando es uno');
  assert.match(html, /extremo del rango/);
  assert.doesNotMatch(html, /vela entera/, 'con vela de sobra no hace falta la nota');

  const alFinal = Ruptura.sideHtml(
    { probability: 0.05, probabilityFullCandle: 0.4, level: 100, distancePct: 1.2, distanceAtr: 0.8, touches: 3, remaining: 0.1 },
    'Ruptura al alza', 'up'
  );
  assert.match(alFinal, /3 toques/);
  assert.match(alFinal, /vela entera por delante sería/, 'quedando poco, se dice qué sería con una vela entera');

  assert.match(Ruptura.sideHtml(null, 'Ruptura al alza', 'up'), /Sin nivel por delante/);
});

// --- Tabla multi-timeframe -------------------------------------------------

test('una diferencia mínima entre EMAs es "Plano", no una tendencia', () => {
  const planas = Array.from({ length: 200 }, () => ({ close: 100 }));
  assert.equal(TablaMtf.veredicto(planas.map((c) => c.close), 20, 50).label, 'Plano');

  const subiendo = Array.from({ length: 200 }, (_, i) => 100 + i);
  assert.equal(TablaMtf.veredicto(subiendo, 20, 50).label, 'Alcista');

  const bajando = Array.from({ length: 200 }, (_, i) => 300 - i);
  assert.equal(TablaMtf.veredicto(bajando, 20, 50).label, 'Bajista');
});

test('sin datos suficientes la tabla no adivina', () => {
  assert.equal(TablaMtf.veredicto([1, 2, 3], 20, 50), null);
  assert.equal(TablaMtf.veredicto([], 20, 50), null);
  const largo = Array.from({ length: 200 }, (_, i) => 100 + i);
  assert.equal(TablaMtf.veredicto(largo, null, 50), null, 'con parámetros inválidos tampoco');
});

test('la tabla pinta cada columna y deja el motivo en el title', () => {
  // Un doble mínimo del DOM: sólo hace falta lo que el módulo toca.
  const celdas = {};
  const celda = (tf) => {
    if (!celdas[tf]) {
      celdas[tf] = { textContent: '', title: '', clases: new Set(),
        classList: { add: (c) => celdas[tf].clases.add(c), remove: (...cs) => cs.forEach((c) => celdas[tf].clases.delete(c)) } };
    }
    return celdas[tf];
  };

  const subiendo = Array.from({ length: 200 }, (_, i) => ({ close: 100 + i }));
  TablaMtf.render({ mtf: { '1h': subiendo, '4h': [] }, fast: 20, slow: 50, timeframes: ['1h', '4h'], celda });

  assert.equal(celdas['1h'].textContent, 'Alcista');
  assert.ok(celdas['1h'].clases.has('bull'));
  assert.match(celdas['1h'].title, /EMA20 .* vs EMA50/);

  assert.equal(celdas['4h'].textContent, '—', 'sin velas no se deja la celda anterior puesta');
  assert.ok(celdas['4h'].clases.has('flat'));
  assert.ok(!celdas['4h'].clases.has('bull'));
});

// --- El panel, contra el análisis de verdad ---------------------------------

test('el panel recalcula lo mismo que devolvió el servidor si el precio no ha cambiado', () => {
  // Es la propiedad que importa: el número en vivo no puede ser otro sistema.
  const { analyzeBreakout } = require('../src/breakout');
  const velas = [];
  let precio = 100;
  for (let i = 0; i < 300; i++) {
    const open = precio;
    const close = open * (1 + Math.sin(i / 7) * 0.004);
    velas.push({
      openTime: i * 3_600_000, open, close,
      high: Math.max(open, close) * 1.002, low: Math.min(open, close) * 0.998,
      volume: 1000, closeTime: i * 3_600_000 + 3_599_999, closed: i < 299,
    });
    precio = close;
  }

  const a = analyzeBreakout(velas, { interval: '1h' });
  assert.equal(a.ok, true);
  assert.ok(Number.isFinite(a.atr) && a.atr > 0);
  assert.ok(Number.isFinite(atr(velas, 14)));

  for (const lado of ['up', 'down']) {
    if (!a[lado]) continue;
    // Con el mismo precio y una vela entera por delante, la probabilidad que
    // recalcula el panel tiene que ser la del análisis.
    const vivo = Ruptura.liveSide(a[lado], a.sample[lado], a.price, a.atr, 1);
    assert.ok(Math.abs(vivo.probability - a[lado].probability) < 1e-9,
      `${lado}: panel ${vivo.probability} vs análisis ${a[lado].probability}`);
  }
});

// --- Que las páginas carguen lo que sus módulos necesitan -------------------
//
// Esto existe por un fallo concreto: el panel de probabilidad leía
// `globalThis.Forecast` y la página no cargaba `forecast.js`. Los 390 tests
// pasaban —en Node el módulo se resuelve con `require`— y la tarjeta reventaba
// en cuanto se escribía un precio. Es el mismo patrón que ya ha mordido antes:
// lo que sólo se rompe en el navegador, en el navegador hay que buscarlo, y si
// se puede comprobar leyendo los archivos, mejor que ir a mirar.

const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const PAGINAS = ['index.html', 'acciones.html'];

const leer = (...p) => fs.readFileSync(path.join(RAIZ, ...p), 'utf8');

// Los módulos que el servidor publica al navegador.
function publicados() {
  const m = leer('server.js').match(/const SHARED_MODULES = \[([^\]]+)\]/);
  assert.ok(m, 'no se encontró SHARED_MODULES en server.js');
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

// Qué deja un módulo en el ámbito global, y qué espera encontrar en él.
function global(archivo) {
  const src = leer('src', archivo);
  const pone = [...src.matchAll(/globalThis\.(\w+)\s*=/g)].map((m) => m[1]);
  // Sin lookahead: `\w+` es codicioso y con un «no seguido de =» detrás
  // retrocedería, sacando `Indicator` de `globalThis.Indicators =`. Se cogen
  // todas y se restan las que el propio módulo define.
  const todas = [...src.matchAll(/globalThis\.(\w+)/g)].map((m) => m[1]);
  return { pone, pide: todas.filter((x) => !pone.includes(x)) };
}

for (const pagina of PAGINAS) {
  test(`${pagina} sólo carga módulos que el servidor publica`, () => {
    const html = leer('public', pagina);
    const cargados = [...html.matchAll(/src="\/lib\/([\w.-]+)"/g)].map((m) => m[1]);
    assert.ok(cargados.length, 'la página tiene que cargar algún módulo compartido');

    for (const m of cargados) {
      assert.ok(publicados().includes(m), `${pagina} carga /lib/${m}, que el servidor devuelve como 404`);
    }
  });

  test(`${pagina} carga cada módulo antes de quien lo necesita`, () => {
    const html = leer('public', pagina);
    const cargados = [...html.matchAll(/src="\/lib\/([\w.-]+)"/g)].map((m) => m[1]);

    const disponibles = new Set();
    for (const archivo of cargados) {
      const { pone, pide } = global(archivo);
      for (const dep of pide) {
        assert.ok(disponibles.has(dep), `${pagina}: ${archivo} necesita globalThis.${dep} y no se ha cargado todavía`);
      }
      for (const nombre of pone) disponibles.add(nombre);
    }
  });

  test(`${pagina} no depende de nada que nadie cargue`, () => {
    // El guion de la página también lee del ámbito global.
    const guion = pagina === 'index.html' ? 'app.js' : 'acciones.js';
    const src = fs.readFileSync(path.join(RAIZ, 'public', guion), 'utf8');
    const pide = [...src.matchAll(/=\s*globalThis\.(\w+)/g)].map((m) => m[1]);
    assert.ok(pide.length, 'algo tendrá que coger del ámbito global');

    const html = leer('public', pagina);
    const cargados = [...html.matchAll(/src="\/lib\/([\w.-]+)"/g)].map((m) => m[1]);
    const disponibles = new Set(cargados.flatMap((a) => global(a).pone));

    for (const dep of pide) {
      assert.ok(disponibles.has(dep), `${guion} usa globalThis.${dep} y ${pagina} no carga ningún módulo que lo defina`);
    }
  });
}

test('el servidor no publica módulos que nadie carga', () => {
  // Publicar código que ninguna página pide es superficie por nada.
  const cargados = new Set(PAGINAS.flatMap((p) => [...leer('public', p).matchAll(/src="\/lib\/([\w.-]+)"/g)].map((m) => m[1])));
  for (const m of publicados()) {
    assert.ok(cargados.has(m), `server.js publica ${m} y ninguna página lo carga`);
  }
});
