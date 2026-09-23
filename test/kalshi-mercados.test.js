'use strict';

// Traducir un contrato de Kalshi a algo que el motor sepa valorar.
//
// La regla que gobierna este archivo: lo que no se entienda con seguridad se
// descarta. No operar un mercado cuesta cero; operarlo al revés porque el
// título cambió una palabra cuesta todo.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const M = require('../src/kalshi-mercados');

const base = {
  ticker: 'KXBTCD-26SEP23-B88000',
  status: 'open',
  strike_type: 'greater',
  floor_strike: 88000,
  expiration_time: '2026-09-23T19:00:00Z',
  yes_bid: 42,
  yes_ask: 45,
};

test('un «por encima de» se lee de los campos, no del título', () => {
  const m = M.normalizar(base);
  assert.equal(m.tipo, 'mayor');
  assert.equal(m.suelo, 88000);
  assert.equal(m.vencimiento, Date.parse('2026-09-23T19:00:00Z'));
});

test('una franja trae sus dos extremos', () => {
  const m = M.normalizar({ ...base, strike_type: 'between', floor_strike: 87000, cap_strike: 88000 });
  assert.equal(m.tipo, 'franja');
  assert.equal(m.suelo, 87000);
  assert.equal(m.techo, 88000);
});

test('un «por debajo de» usa el techo', () => {
  const m = M.normalizar({ ...base, strike_type: 'less', floor_strike: null, cap_strike: 88000 });
  assert.equal(m.tipo, 'menor');
  assert.equal(m.techo, 88000);
});

test('lo que no se sabe leer se descarta, no se adivina', () => {
  // El caso que importa: un mercado con título clarísimo y sin campos. Deducir
  // «por encima de 90k» del texto funciona hasta que cambian una palabra.
  assert.equal(M.normalizar({ ...base, strike_type: null, floor_strike: null, cap_strike: null, title: 'BTC above $90,000?' }), null);
  assert.equal(M.normalizar({ ...base, strike_type: 'escalera' }), null);
  assert.equal(M.normalizar({ ...base, strike_type: 'between', cap_strike: 80000 }), null, 'una franja invertida no vale');
  assert.equal(M.normalizar({ ...base, expiration_time: null, close_time: null }), null, 'sin vencimiento no hay plazo');
  assert.equal(M.normalizar(null), null);
});

test('un mercado ya cerrado o liquidado no se devuelve', () => {
  assert.equal(M.normalizar({ ...base, status: 'closed' }), null);
  assert.equal(M.normalizar({ ...base, status: 'settled' }), null);
});

test('se entienden las dos generaciones de precios de Kalshi', () => {
  // Antes céntimos enteros, ahora dólares decimales. Un despliegue contra
  // cualquiera de las dos tiene que seguir funcionando.
  assert.equal(M.normalizar(base).yesAsk, 0.45);

  const nuevo = M.normalizar({ ...base, yes_bid_dollars: 0.42, yes_ask_dollars: 0.45 });
  assert.equal(nuevo.yesAsk, 0.45);
  assert.equal(nuevo.yesBid, 0.42);
});

test('si falta un lado se deriva del otro', () => {
  // Comprar NO a `n` es exactamente vender SÍ a `1 − n`, así que el lado que
  // falte se puede reconstruir sin inventarse nada.
  const m = M.normalizar(base);
  assert.ok(Math.abs(m.noBid - (1 - 0.45)) < 1e-9);
  assert.ok(Math.abs(m.noAsk - (1 - 0.42)) < 1e-9);
});

test('el tamaño del libro viaja, porque decide el tamaño de la orden', () => {
  const m = M.normalizar({ ...base, yes_ask_quantity: 300 });
  assert.equal(m.libro.yesAsk, 300);
});

// --- Contra un servidor que imita a Kalshi ---------------------------------

test('listarMercados cuenta lo que descarta', async () => {
  // Si de cuarenta mercados no se entiende ninguno, eso NO es «hoy no hay
  // oportunidades»: es un fallo nuestro, y tiene que verse.
  const servidor = http.createServer((req, res) => {
    assert.match(req.url, /series_ticker=KXBTCD/);
    assert.match(req.url, /status=open/);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      markets: [
        base,
        { ...base, ticker: 'B', strike_type: 'between', floor_strike: 87000, cap_strike: 88000 },
        { ...base, ticker: 'C', strike_type: null, floor_strike: null, title: 'algo raro' },
      ],
    }));
  });

  await new Promise((r) => servidor.listen(0, r));
  const anterior = process.env.KALSHI_API;
  process.env.KALSHI_API = `http://127.0.0.1:${servidor.address().port}`;
  delete require.cache[require.resolve('../src/kalshi-mercados')];
  const Mod = require('../src/kalshi-mercados');

  try {
    const r = await Mod.listarMercados({ serie: 'KXBTCD' });
    assert.equal(r.total, 3);
    assert.equal(r.entendidos, 2);
    assert.equal(r.descartados, 1);
    assert.deepEqual(r.mercados.map((m) => m.tipo), ['mayor', 'franja']);
  } finally {
    servidor.close();
    if (anterior === undefined) delete process.env.KALSHI_API;
    else process.env.KALSHI_API = anterior;
    delete require.cache[require.resolve('../src/kalshi-mercados')];
  }
});

test('sin serie no se llama a nada', async () => {
  // Un ticker vacío devolvería una lista vacía y parecería un día tranquilo.
  await assert.rejects(() => M.listarMercados({}), /series_ticker/);
});

// --- Explorar qué series hay ------------------------------------------------

test('explorar agrupa por serie y cuenta cuántos contratos se entienden', async () => {
  // La columna que importa es «entendidos»: una serie con mil mercados de los
  // que entendemos cero no se puede operar, y sin esto parecería normal.
  let pagina = 0;
  const servidor = http.createServer((req, res) => {
    pagina++;
    assert.match(req.url, /^\/events/, 'se explora por eventos, no por el listado general');
    assert.match(req.url, /with_nested_markets=true/);
    assert.match(req.url, /status=open/);
    if (pagina === 2) assert.match(req.url, /cursor=siguiente/, 'la segunda página sigue el cursor');

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(pagina === 1 ? {
      cursor: 'siguiente',
      events: [
        { series_ticker: 'KXBTCD', title: 'Bitcoin', markets: [
          { ...base, ticker: 'KXBTCD-1', volume: 100 },
          { ...base, ticker: 'KXBTCD-2', strike_type: 'between', floor_strike: 1, cap_strike: 2, volume: 50 },
        ] },
        // Sin campos legibles: cuenta como mercado, no como entendido.
        { series_ticker: 'KXRAIN', title: '¿Lloverá?', markets: [{ ticker: 'KXRAIN-1', status: 'open', title: '¿Lloverá?', volume: 9999 }] },
      ],
    } : { cursor: null, events: [{ series_ticker: 'KXBTCD', markets: [{ ...base, ticker: 'KXBTCD-3', volume: 10 }] }] }));
  });

  await new Promise((r) => servidor.listen(0, r));
  const anterior = process.env.KALSHI_API;
  process.env.KALSHI_API = `http://127.0.0.1:${servidor.address().port}`;
  delete require.cache[require.resolve('../src/kalshi-mercados')];
  const Mod = require('../src/kalshi-mercados');

  try {
    const r = await Mod.explorarSeries();
    assert.equal(r.total, 4, 'se miraron las dos páginas');

    const btc = r.series.find((s) => s.serie === 'KXBTCD');
    assert.equal(btc.mercados, 3);
    assert.equal(btc.entendidos, 3);
    assert.deepEqual(btc.formas.sort(), ['franja', 'mayor']);

    const lluvia = r.series.find((s) => s.serie === 'KXRAIN');
    assert.equal(lluvia.mercados, 1);
    assert.equal(lluvia.entendidos, 0, 'mucho volumen y cero entendidos');

    // Ordena por entendidos, no por volumen: KXRAIN mueve cien veces más.
    assert.equal(r.series[0].serie, 'KXBTCD');
  } finally {
    servidor.close();
    if (anterior === undefined) delete process.env.KALSHI_API;
    else process.env.KALSHI_API = anterior;
    delete require.cache[require.resolve('../src/kalshi-mercados')];
  }
});

test('explorar sabe filtrar por nombre', async () => {
  const servidor = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      cursor: null,
      events: [
        { series_ticker: 'KXBTCD', title: 'Bitcoin', markets: [{ ...base, ticker: 'KXBTCD-1' }] },
        { series_ticker: 'KXETHD', title: 'Ethereum', markets: [{ ...base, ticker: 'KXETHD-1' }] },
      ],
    }));
  });

  await new Promise((r) => servidor.listen(0, r));
  const anterior = process.env.KALSHI_API;
  process.env.KALSHI_API = `http://127.0.0.1:${servidor.address().port}`;
  delete require.cache[require.resolve('../src/kalshi-mercados')];
  const Mod = require('../src/kalshi-mercados');

  try {
    const r = await Mod.explorarSeries({ filtro: 'btc' });
    assert.deepEqual(r.series.map((s) => s.serie), ['KXBTCD'], 'y no distingue mayúsculas');
  } finally {
    servidor.close();
    if (anterior === undefined) delete process.env.KALSHI_API;
    else process.env.KALSHI_API = anterior;
    delete require.cache[require.resolve('../src/kalshi-mercados')];
  }
});

test('cuando no sale nada, se dice QUÉ respondió la API', async () => {
  // El fallo que esto evita: una respuesta con otra forma dejaba la lista
  // vacía y el escáner enseñaba una tabla en blanco, indistinguible de «hoy no
  // hay mercados». Es la conclusión equivocada y la que más tiempo hace perder.
  const servidor = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    // Un envoltorio distinto del que esperamos: ni error, ni mercados.
    res.end(JSON.stringify({ data: { items: [] }, next: null }));
  });

  await new Promise((r) => servidor.listen(0, r));
  const anterior = process.env.KALSHI_API;
  process.env.KALSHI_API = `http://127.0.0.1:${servidor.address().port}`;
  delete require.cache[require.resolve('../src/kalshi-mercados')];
  const Mod = require('../src/kalshi-mercados');

  try {
    const r = await Mod.explorarSeries();
    assert.equal(r.total, 0);
    assert.equal(r.series.length, 0);

    // Y aquí está lo que hace que no se quede uno adivinando.
    assert.deepEqual(r.diagnostico.envoltura, ['data', 'next'], 'los campos que sí vinieron');
    assert.match(r.diagnostico.muestra, /items/);
    assert.equal(r.diagnostico.paginas, 1);
  } finally {
    servidor.close();
    if (anterior === undefined) delete process.env.KALSHI_API;
    else process.env.KALSHI_API = anterior;
    delete require.cache[require.resolve('../src/kalshi-mercados')];
  }
});

test('las apuestas combinadas MVE se saltan, y se cuentan', async () => {
  // La primera exploración contra Kalshi de verdad devolvió 600 mercados y los
  // 600 eran MVE: combinadas de varias patas, que este motor no valora. Sin
  // saltarlas no se llega a ver ni un contrato de cripto, y la tabla salía con
  // dos series y cero entendidos, que parecía un fallo del traductor.
  const servidor = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      cursor: null,
      events: [
        { series_ticker: 'KXMVE', title: 'Combinadas', markets: [
          { ...base, ticker: 'KXMVE-1', mve_collection_ticker: 'ALGO' },
          { ...base, ticker: 'KXMVE-2', mve_selected_legs: [{ x: 1 }] },
        ] },
        { series_ticker: 'KXBTCD', title: 'Bitcoin', markets: [{ ...base, ticker: 'KXBTCD-1' }] },
      ],
    }));
  });

  await new Promise((r) => servidor.listen(0, r));
  const anterior = process.env.KALSHI_API;
  process.env.KALSHI_API = `http://127.0.0.1:${servidor.address().port}`;
  delete require.cache[require.resolve('../src/kalshi-mercados')];
  const Mod = require('../src/kalshi-mercados');

  try {
    const r = await Mod.explorarSeries();
    assert.deepEqual(r.series.map((s) => s.serie), ['KXBTCD'], 'las MVE no llegan a la tabla');
    assert.equal(r.diagnostico.mve, 2, 'pero se dice cuántas se saltaron');
    assert.equal(Mod.esMve({ mve_collection_ticker: 'X' }), true);
    assert.equal(Mod.esMve({ mve_selected_legs: [] }), false, 'una lista vacía no es una combinada');
    assert.equal(Mod.esMve(base), false);
  } finally {
    servidor.close();
    if (anterior === undefined) delete process.env.KALSHI_API;
    else process.env.KALSHI_API = anterior;
    delete require.cache[require.resolve('../src/kalshi-mercados')];
  }
});

test('una serie que no se entiende enseña al menos su título', () => {
  // Con la columna «ejemplo» vacía no hay forma de saber qué es esa serie ni
  // si merece la pena arreglar el traductor para ella.
  const raro = { ticker: 'KXRARO-1', series_ticker: 'KXRARO', status: 'open', title: '¿Lloverá en Madrid?' };
  assert.equal(M.normalizar(raro), null, 'no se entiende');
  // El título sale del propio mercado, que es lo que el explorador enseña.
  assert.equal(raro.title, '¿Lloverá en Madrid?');
});

test('el explorador dice cuándo vence lo más cercano de cada serie', async () => {
  // Es la columna que decide si una serie es operable POR ESTE motor. Una de
  // contratos a ocho días y otra a una hora se parecen en todo lo demás, y la
  // primera se descarta entera por vencer más allá de donde el modelo está
  // medido. Enterarse ahí abajo, mercado a mercado, es tarde.
  const ahora = Date.parse('2026-09-23T12:00:00Z');
  const en = (h) => new Date(ahora + h * 3600_000).toISOString();

  const servidor = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      cursor: null,
      events: [
        { series_ticker: 'KXHORA', title: 'BTC por horas', markets: [
          { ...base, ticker: 'KXHORA-1', expiration_time: en(1) },
          { ...base, ticker: 'KXHORA-2', expiration_time: en(6) },
          { ...base, ticker: 'KXHORA-3', expiration_time: en(200) },
        ] },
        { series_ticker: 'KXSEMANA', title: 'BTC por semanas', markets: [
          { ...base, ticker: 'KXSEMANA-1', expiration_time: en(190) },
        ] },
      ],
    }));
  });

  await new Promise((r) => servidor.listen(0, r));
  const anterior = process.env.KALSHI_API;
  process.env.KALSHI_API = `http://127.0.0.1:${servidor.address().port}`;
  delete require.cache[require.resolve('../src/kalshi-mercados')];
  const Mod = require('../src/kalshi-mercados');

  try {
    const r = await Mod.explorarSeries({ ahora });

    const hora = r.series.find((s) => s.serie === 'KXHORA');
    assert.equal(hora.vencePronto, 3600_000, 'lo más cercano, no lo primero que salga');
    assert.equal(hora.dentroDeUnDia, 2, 'los de 1 h y 6 h; el de 200 h no');

    const semana = r.series.find((s) => s.serie === 'KXSEMANA');
    assert.equal(semana.dentroDeUnDia, 0, 'una serie a ocho días no tiene nada operable');
    assert.ok(semana.vencePronto > 24 * 3600_000);
  } finally {
    servidor.close();
    if (anterior === undefined) delete process.env.KALSHI_API;
    else process.env.KALSHI_API = anterior;
    delete require.cache[require.resolve('../src/kalshi-mercados')];
  }
});

test('el explorador dice si recorrió el listado entero o se quedó sin páginas', async () => {
  // Son conclusiones opuestas: agotado significa que esa serie no existe;
  // quedarse sin páginas, que hay que seguir mirando. Sin distinguirlas se
  // acaba concluyendo lo primero cuando pasaba lo segundo.
  let pagina = 0;
  const servidor = http.createServer((req, res) => {
    pagina++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      cursor: 'siempre-hay-mas',
      events: [{ series_ticker: `S${pagina}`, title: 'algo', markets: [{ ...base, ticker: `S${pagina}-1` }] }],
    }));
  });

  await new Promise((r) => servidor.listen(0, r));
  const anterior = process.env.KALSHI_API;
  process.env.KALSHI_API = `http://127.0.0.1:${servidor.address().port}`;
  delete require.cache[require.resolve('../src/kalshi-mercados')];
  const Mod = require('../src/kalshi-mercados');

  try {
    const corto = await Mod.explorarSeries({ paginas: 3 });
    assert.equal(corto.diagnostico.paginas, 3);
    assert.equal(corto.diagnostico.agotado, false, 'el servidor sigue ofreciendo cursor');
  } finally {
    servidor.close();
    if (anterior === undefined) delete process.env.KALSHI_API;
    else process.env.KALSHI_API = anterior;
    delete require.cache[require.resolve('../src/kalshi-mercados')];
  }
});

test('sin cursor, el listado se da por agotado', async () => {
  const servidor = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ cursor: null, events: [{ series_ticker: 'KXBTCD', markets: [{ ...base, ticker: 'KXBTCD-1' }] }] }));
  });

  await new Promise((r) => servidor.listen(0, r));
  const anterior = process.env.KALSHI_API;
  process.env.KALSHI_API = `http://127.0.0.1:${servidor.address().port}`;
  delete require.cache[require.resolve('../src/kalshi-mercados')];
  const Mod = require('../src/kalshi-mercados');

  try {
    const r = await Mod.explorarSeries({ paginas: 25 });
    assert.equal(r.diagnostico.agotado, true, 'se vio todo lo que hay');
  } finally {
    servidor.close();
    if (anterior === undefined) delete process.env.KALSHI_API;
    else process.env.KALSHI_API = anterior;
    delete require.cache[require.resolve('../src/kalshi-mercados')];
  }
});

test('el plazo sale del CIERRE, no de la fecha de expiración', () => {
  // Lo descubrieron los datos reales: un contrato titulado «Bitcoin price on
  // Sep 25» salía con vencimiento a siete días mirándolo el día 23. Cinco días
  // de plazo fantasma, en un motor cuyo límite son veinticuatro horas: o sea,
  // rechazarlo todo por una fecha mal elegida.
  const m = M.normalizar({
    ...base,
    close_time: '2026-09-25T20:00:00Z',
    expiration_time: '2026-09-30T20:00:00Z',
  });

  assert.equal(m.vencimiento, Date.parse('2026-09-25T20:00:00Z'), 'manda el cierre');
  assert.equal(m.expira, Date.parse('2026-09-30T20:00:00Z'), 'pero la otra no se pierde');
  assert.ok(m.expira > m.vencimiento);
});

test('`expected_expiration_time` gana a `expiration_time` cuando no hay cierre', () => {
  const m = M.normalizar({
    ...base,
    close_time: null,
    expected_expiration_time: '2026-09-25T20:00:00Z',
    expiration_time: '2026-10-30T20:00:00Z',
  });
  assert.equal(m.vencimiento, Date.parse('2026-09-25T20:00:00Z'));
});

test('sin ninguna fecha utilizable el mercado se descarta', () => {
  assert.equal(M.normalizar({ ...base, close_time: null, expiration_time: null }), null);
});

test('el explorador mide cuánto se separan las dos fechas', async () => {
  // Una separación grande es la señal de estar leyendo la fecha equivocada.
  const ahora = Date.parse('2026-09-23T12:00:00Z');
  const servidor = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      cursor: null,
      events: [{ series_ticker: 'KXBTCD', title: 'BTC', markets: [{
        ...base,
        close_time: '2026-09-25T20:00:00Z',
        expiration_time: '2026-09-30T20:00:00Z',
      }] }],
    }));
  });

  await new Promise((r) => servidor.listen(0, r));
  const anterior = process.env.KALSHI_API;
  process.env.KALSHI_API = `http://127.0.0.1:${servidor.address().port}`;
  delete require.cache[require.resolve('../src/kalshi-mercados')];
  const Mod = require('../src/kalshi-mercados');

  try {
    const r = await Mod.explorarSeries({ ahora });
    assert.equal(r.series[0].brecha, 5 * 24 * 3600_000, 'cinco días de diferencia');
  } finally {
    servidor.close();
    if (anterior === undefined) delete process.env.KALSHI_API;
    else process.env.KALSHI_API = anterior;
    delete require.cache[require.resolve('../src/kalshi-mercados')];
  }
});

test('se puede pedir un mercado suelto, crudo y leído a la vez', async () => {
  // Para cuando un título y un plazo no cuadran: hace falta ver la respuesta
  // tal cual la manda Kalshi, con las cuatro fechas al lado.
  const servidor = http.createServer((req, res) => {
    assert.match(req.url, /^\/markets\/KXBTCD-26SEP25-B130000$/);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ market: { ...base, ticker: 'KXBTCD-26SEP25-B130000', title: 'Bitcoin price on Sep 25?' } }));
  });

  await new Promise((r) => servidor.listen(0, r));
  const anterior = process.env.KALSHI_API;
  process.env.KALSHI_API = `http://127.0.0.1:${servidor.address().port}`;
  delete require.cache[require.resolve('../src/kalshi-mercados')];
  const Mod = require('../src/kalshi-mercados');

  try {
    const { crudo, leido } = await Mod.verMercado({ ticker: 'KXBTCD-26SEP25-B130000' });
    assert.equal(crudo.title, 'Bitcoin price on Sep 25?', 'lo crudo, sin interpretar');
    assert.equal(leido.tipo, 'mayor', 'y lo que entendemos de ello');
    await assert.rejects(() => Mod.verMercado({}), /ticker/);
  } finally {
    servidor.close();
    if (anterior === undefined) delete process.env.KALSHI_API;
    else process.env.KALSHI_API = anterior;
    delete require.cache[require.resolve('../src/kalshi-mercados')];
  }
});
