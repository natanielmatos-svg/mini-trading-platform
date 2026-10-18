'use strict';

// El libro de órdenes: de dónde sale el precio con el que se decide.
//
// El otro archivo que movía dinero sin una sola prueba. Y el suyo es el extremo
// de entrada: si el libro se traduce mal, todo lo que viene después —ventaja,
// tamaño, orden— se calcula sobre un precio que no existe, y cada pieza de
// abajo parecerá correcta mientras lo hace.

const test = require('node:test');
const assert = require('node:assert');

const Book = require('../src/kalshi-book');

// Un libro como lo manda Kalshi: pares [precio en dólares, cantidad].
const crudo = (yes, no) => ({ orderbook_fp: { yes_dollars: yes, no_dollars: no } });

// --- Traducir el libro ------------------------------------------------------

test('los niveles salen ordenados de mejor a peor', () => {
  // Kalshi no promete orden, y todo lo de abajo lee `[0]` como «el mejor».
  const b = Book.normalizar(crudo([[0.41, 10], [0.44, 5], [0.42, 7]], [[0.50, 3]]));
  assert.deepEqual(b.yes.map((n) => n.precio), [0.44, 0.42, 0.41]);
  assert.equal(b.yes[0].cantidad, 5);
});

test('un nivel sin nadie detrás no cuenta como profundidad', () => {
  const b = Book.normalizar(crudo([[0.44, 0], [0.42, 7]], [[0.50, 0]]));
  assert.deepEqual(b.yes.map((n) => n.precio), [0.42]);
  assert.deepEqual(b.no, []);
});

test('un libro sin profundidad comprobable se rechaza, no se da por vacío', () => {
  // Darlo por vacío diría «no hay nadie al otro lado» cuando lo que pasa es que
  // no sabemos, y eso aguas abajo se lee como un mercado sin liquidez.
  for (const malo of [{}, { orderbook_fp: {} }, { orderbook_fp: { yes_dollars: null, no_dollars: [] } }, null]) {
    assert.throws(() => Book.normalizar(malo), /profundidad verificable/, JSON.stringify(malo));
  }
});

test('un nivel con precio o cantidad imposibles se rechaza', () => {
  // Un contrato binario cotiza estrictamente entre 0 y 1. Un 1,20 ahí dentro
  // significa que estamos leyendo céntimos como dólares, y vale más parar que
  // operar con la escala equivocada.
  for (const malo of [[[1.2, 5]], [[0, 5]], [[1, 5]], [[-0.1, 5]], [[0.4, -3]], [[0.4, NaN]], [['x', 5]]]) {
    assert.throws(() => Book.normalizar(crudo(malo, [[0.5, 1]])), /Nivel de libro inválido/, JSON.stringify(malo));
  }
});

test('la hora del libro es la que se le pasa, no la de ahora', () => {
  // `obtener` la toma al EMPEZAR la petición: una respuesta lenta no puede
  // rejuvenecer una cotización vieja.
  const b = Book.normalizar(crudo([[0.4, 1]], [[0.5, 1]]), 1_700_000_000_000);
  assert.equal(b.at, 1_700_000_000_000);
});

// --- Convertir el libro en precios de compra y venta ------------------------

test('comprar SÍ es levantar la puja del NO', () => {
  // La identidad que sostiene todo: un contrato binario tiene un solo libro
  // visto desde dos lados. Si esto se invierte, el motor compra caro creyendo
  // que compra barato, y ninguna prueba de más abajo lo nota.
  const b = Book.normalizar(crudo([[0.42, 100]], [[0.55, 80]]));
  const m = Book.aplicar({ ticker: 'KXBTCD-X' }, b);

  assert.equal(m.yesBid, 0.42, 'la mejor puja por el SÍ');
  assert.equal(m.noBid, 0.55, 'la mejor puja por el NO');
  assert.equal(m.yesAsk, 0.45, 'comprar SÍ cuesta 1 − la puja del NO');
  assert.equal(m.noAsk, 0.58, 'comprar NO cuesta 1 − la puja del SÍ');
  assert.equal(m.ticker, 'KXBTCD-X', 'y el mercado sigue siendo el mismo');
});

test('las cantidades disponibles vienen del lado contrario', () => {
  // Lo que se puede COMPRAR de SÍ es lo que hay puesto en la puja del NO.
  // Mirar el lado propio daría un tamaño que no se puede ejecutar.
  const b = Book.normalizar(crudo([[0.42, 100]], [[0.55, 80]]));
  const m = Book.aplicar({}, b);
  assert.equal(m.libro.yesAsk, 80, 'para comprar SÍ, lo que hay en el NO');
  assert.equal(m.libro.noAsk, 100, 'y al revés');
  assert.equal(m.libro.yesBid, 100);
  assert.equal(m.libro.noBid, 80);
});

test('los dos lados cuadran, que es lo que el motor comprueba antes de operar', () => {
  // `kalshi-edge` descarta un mercado cuando `1 − noAsk` no es `yesBid`: lo
  // lee como cotización vieja. Si esta conversión dejara de cumplirlo, el bot
  // no operaría NADA y el motivo apuntaría al sitio equivocado.
  for (const [y, n] of [[0.42, 0.55], [0.01, 0.98], [0.5, 0.49], [0.33, 0.66]]) {
    const m = Book.aplicar({}, Book.normalizar(crudo([[y, 10]], [[n, 10]])));
    assert.ok(Math.abs((1 - m.noAsk) - m.yesBid) < 1e-9, `1 − noAsk debería ser yesBid (${y}/${n})`);
    assert.ok(Math.abs((1 - m.noBid) - m.yesAsk) < 1e-9, `1 − noBid debería ser yesAsk (${y}/${n})`);
  }
});

test('la horquilla nunca sale negativa con un libro sano', () => {
  const m = Book.aplicar({}, Book.normalizar(crudo([[0.42, 10]], [[0.55, 10]])));
  assert.ok(m.yesAsk >= m.yesBid, `${m.yesAsk} debería ser al menos ${m.yesBid}`);
  assert.ok(m.noAsk >= m.noBid);
});

test('un lado vacío deja su precio en nulo, no en cero', () => {
  // Cero es un precio; nulo es «no se puede». Confundirlos haría que el motor
  // viese una ganga donde no hay contrapartida.
  const m = Book.aplicar({}, Book.normalizar(crudo([], [[0.55, 10]])));
  assert.equal(m.yesBid, null);
  assert.equal(m.noAsk, null, 'sin puja por el SÍ no se puede comprar NO');
  assert.equal(m.yesAsk, 0.45, 'pero sí comprar SÍ, que es lo que hay');
  assert.equal(m.libro.yesBid, 0);

  const vacio = Book.aplicar({}, Book.normalizar(crudo([], [])));
  assert.equal(vacio.yesBid, null);
  assert.equal(vacio.yesAsk, null);
  assert.equal(vacio.noBid, null);
  assert.equal(vacio.noAsk, null);
});

test('el sello de hora del libro viaja con el mercado', () => {
  // Sin él no hay forma de saber, más abajo, si se está decidiendo con una
  // cotización de hace diez segundos.
  const m = Book.aplicar({}, Book.normalizar(crudo([[0.4, 1]], [[0.5, 1]]), 1_700_000_000_000));
  assert.equal(m.bookAt, 1_700_000_000_000);
});

test('`aplicar` no toca el mercado que recibe', () => {
  const original = { ticker: 'KXBTCD-X', tipo: 'mayor', suelo: 130000 };
  const copia = { ...original };
  Book.aplicar(original, Book.normalizar(crudo([[0.4, 1]], [[0.5, 1]])));
  assert.deepEqual(original, copia, 'se devuelve uno nuevo, no se muta el de entrada');
});
