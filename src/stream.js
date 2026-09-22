'use strict';

// Datos en vivo.
//
// El navegador no habla con Binance: habla con este servidor por SSE
// (Server-Sent Events) y el servidor mantiene una única conexión WebSocket por
// símbolo+timeframe, compartida por todos los clientes conectados. Cien
// pestañas abiertas siguen siendo una conexión saliente, igual que la caché de
// /api/klines convierte N peticiones en una.
//
// Tres fuentes, en orden de preferencia:
//   ws    WebSocket de Binance. Tick a tick, es lo que se quiere.
//   poll  Si el WebSocket no existe (Node viejo) o no levanta, se reconsulta
//         /api/klines cacheado. Peor resolución, pero la página no se queda
//         muerta.
//   demo  Velas sintéticas, sin salir a Internet.
//
// SSE y no WebSocket hacia el navegador a propósito: el flujo es de ida, pasa
// por cualquier proxy como HTTP normal y el navegador reconecta solo.

const { buildDemoCandles, intervalMs, getKlines } = require('./klines');

// Sin `/ws`: se usa el endpoint combinado, que permite pedir dos flujos en una
// sola conexión.
const WS_BASE = (process.env.BINANCE_WS || 'wss://stream.binance.com:9443').replace(/\/ws$/, '');
const HEARTBEAT_MS = 20_000;   // por debajo del proxy_read_timeout de Nginx
const LINGER_MS = 30_000;      // margen antes de cerrar el upstream sin clientes
const DEMO_TICK_MS = 2_000;
const DEMO_PRICE_MS = 400;     // el precio se mueve más a menudo que la vela
// BTCUSDT puede operar decenas de veces por segundo. Retransmitir cada
// operación a cada cliente es tráfico que nadie puede leer: el ojo no
// distingue más de unas diez actualizaciones por segundo, así que se agrupan.
const PRICE_THROTTLE_MS = 100;
const POLL_MIN_MS = 5_000;
const MAX_BACKOFF_MS = 30_000;
const WS_RETRY_AFTER_MS = 5 * 60_000; // tras degradar a poll, reintentar el WS
const WS_STABLE_MS = 60_000;          // a partir de aquí, una conexión se considera sana

function tickFromKline(k) {
  return {
    openTime: Number(k.t),
    closeTime: Number(k.T),
    open: Number(k.o),
    high: Number(k.h),
    low: Number(k.l),
    close: Number(k.c),
    volume: Number(k.v),
    trades: Number(k.n) || 0,
    closed: Boolean(k.x),
  };
}

// El precio de una operación agregada. El flujo de velas empuja cada uno o dos
// segundos —suficiente para dibujar, insuficiente para que el número de la
// pantalla parezca vivo—, así que el precio viene de @aggTrade, que manda una
// actualización por operación.
function priceFromAggTrade(msg) {
  return {
    price: Number(msg.p),
    quantity: Number(msg.q),
    at: Number(msg.T) || Date.now(),
  };
}

function tickFromCandle(candle) {
  return {
    openTime: candle.openTime,
    closeTime: candle.closeTime,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    trades: candle.trades || 0,
    closed: Boolean(candle.closed),
  };
}

class MarketStream {
  constructor({ demo = false } = {}) {
    this.demo = demo;
    this.rooms = new Map();
  }

  key(symbol, interval) {
    return `${symbol}|${interval}`;
  }

  // Un cliente es cualquier cosa que sepa recibir: el servidor le pasa un
  // adaptador sobre la respuesta HTTP, y los tests uno de mentira.
  subscribe(symbol, interval, client) {
    const key = this.key(symbol, interval);
    let room = this.rooms.get(key);

    if (!room) {
      room = { symbol, interval, clients: new Set(), source: null, ws: null, timer: null, closeTimer: null, failures: 0, lastTick: null, degradedAt: 0 };
      this.rooms.set(key, room);
    }

    if (room.closeTimer) {
      clearTimeout(room.closeTimer);
      room.closeTimer = null;
    }

    room.clients.add(client);
    if (room.lastTick) client.send('kline', { symbol, interval, source: room.source, ...room.lastTick });
    if (room.lastPrice) client.send('price', { symbol, interval, source: room.source, ...room.lastPrice });
    this.ensureUpstream(room);

    return () => this.unsubscribe(symbol, interval, client);
  }

  unsubscribe(symbol, interval, client) {
    const room = this.rooms.get(this.key(symbol, interval));
    if (!room) return;
    room.clients.delete(client);
    if (room.clients.size) return;

    // No se corta el upstream en cuanto se va el último cliente: recargar la
    // página cerraría y reabriría el WebSocket cada vez.
    room.closeTimer = setTimeout(() => {
      this.stopUpstream(room);
      this.rooms.delete(this.key(symbol, interval));
    }, LINGER_MS);
    room.closeTimer.unref?.();
  }

  broadcast(room, tick) {
    room.lastTick = tick;
    this.emit(room, 'kline', tick);
  }

  // El precio va por su propio evento: llega mucho más a menudo que la vela y
  // el navegador sólo tiene que repintar un número, no recalcular el gráfico.
  //
  // Se guarda siempre el último (quien se suscriba ahora quiere el de verdad)
  // pero se manda como mucho diez veces por segundo. Lo que se descarta son
  // los precios intermedios, nunca el más reciente: al vencer la ventana sale
  // el último que haya entrado.
  broadcastPrice(room, price) {
    room.lastPrice = price;

    const ahora = Date.now();
    const desde = ahora - (room.priceSentAt || 0);

    if (desde >= PRICE_THROTTLE_MS) {
      room.priceSentAt = ahora;
      this.emit(room, 'price', price);
      return;
    }

    if (room.priceFlush) return;
    room.priceFlush = setTimeout(() => {
      room.priceFlush = null;
      room.priceSentAt = Date.now();
      if (room.lastPrice) this.emit(room, 'price', room.lastPrice);
    }, PRICE_THROTTLE_MS - desde);
    room.priceFlush.unref?.();
  }

  emit(room, event, data) {
    const payload = { symbol: room.symbol, interval: room.interval, source: room.source, ...data };
    for (const client of room.clients) {
      try {
        client.send(event, payload);
      } catch {
        room.clients.delete(client);
      }
    }
  }

  ensureUpstream(room) {
    if (room.source) return;

    if (this.demo) {
      room.source = 'demo';
      this.startDemo(room);
      return;
    }

    const canUseWs = typeof WebSocket === 'function';
    const wsCoolingDown = room.degradedAt && Date.now() - room.degradedAt < WS_RETRY_AFTER_MS;

    if (canUseWs && !wsCoolingDown) {
      room.source = 'ws';
      this.startWebSocket(room);
    } else {
      room.source = 'poll';
      this.startPolling(room);
    }
  }

  stopUpstream(room) {
    if (room.timer) clearInterval(room.timer);
    if (room.priceTimer) clearInterval(room.priceTimer);
    if (room.retryTimer) clearTimeout(room.retryTimer);
    if (room.priceFlush) clearTimeout(room.priceFlush);
    room.timer = null;
    room.priceTimer = null;
    room.retryTimer = null;
    room.priceFlush = null;
    if (room.ws) {
      try {
        room.ws.close();
      } catch {
        /* el socket ya estaba roto */
      }
      room.ws = null;
    }
    room.source = null;
  }

  startDemo(room) {
    const emitVela = () => {
      const [candle] = buildDemoCandles({ symbol: room.symbol, interval: room.interval, limit: 1, now: Date.now() });
      if (candle) this.broadcast(room, tickFromCandle(candle));
    };

    // El precio se mueve entre vela y vela, como en el mercado: pequeñas
    // sacudidas alrededor del precio al contado.
    //
    // Se ancla a la vela de un minuto y NO a la del timeframe elegido: el
    // precio al contado es uno solo, no depende de con qué lupa lo mires. Con
    // la del timeframe, el titular y el consolidado de /api/price —que usa la
    // de un minuto— se separaban hasta un 0,15%, mucho más que la diferencia
    // real entre mercados que este panel quiere enseñar.
    const emitPrecio = () => {
      const [contado] = buildDemoCandles({ symbol: room.symbol, interval: '1m', limit: 1, now: Date.now() });
      const base = contado ? contado.close : null;
      if (!base) return;
      const sacudida = (Math.random() - 0.5) * base * 0.0004;
      this.broadcastPrice(room, { price: base + sacudida, quantity: Math.random() * 2, at: Date.now() });
    };

    emitVela();
    emitPrecio();
    room.timer = setInterval(emitVela, DEMO_TICK_MS);
    room.priceTimer = setInterval(emitPrecio, DEMO_PRICE_MS);
    room.timer.unref?.();
    room.priceTimer.unref?.();
  }

  startPolling(room) {
    const period = Math.max(Math.round(intervalMs(room.interval) / 60), POLL_MIN_MS);
    const emit = async () => {
      try {
        const { candles } = await getKlines({ symbol: room.symbol, interval: room.interval, limit: 2, demo: this.demo });
        const last = candles[candles.length - 1];
        if (last) {
          this.broadcast(room, tickFromCandle(last));
          this.broadcastPrice(room, { price: last.close, quantity: 0, at: Date.now() });
        }
      } catch (err) {
        this.notifyStatus(room, 'error', err.message);
      }
    };
    emit();
    room.timer = setInterval(emit, period);
    room.timer.unref?.();
  }

  startWebSocket(room) {
    // Dos flujos en una conexión: la vela para el gráfico y el análisis, y las
    // operaciones para que el precio se mueva de verdad.
    const par = room.symbol.toLowerCase();
    const url = `${WS_BASE}/stream?streams=${par}@kline_${room.interval}/${par}@aggTrade`;
    let ws;

    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.onWsFailure(room, err.message);
      return;
    }

    room.ws = ws;

    ws.onopen = () => {
      room.connectedAt = Date.now();
      this.notifyStatus(room, 'live', 'WebSocket de Binance conectado');
    };

    ws.onmessage = (event) => {
      // Recibir un mensaje es la única prueba de que el stream sirve. Abrir el
      // socket no lo es: un upstream que acepta la conexión y la cuelga acto
      // seguido dispara `open` en cada reintento, y si el contador de fallos
      // se reiniciara ahí nunca llegaría a tres — se reconectaría cada segundo
      // para siempre en vez de degradar a sondeo.
      room.failures = 0;

      try {
        const bruto = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
        // El endpoint combinado envuelve cada mensaje en {stream, data}; el
        // simple los manda pelados. Se aceptan las dos formas.
        const msg = bruto && bruto.data ? bruto.data : bruto;
        if (!msg) return;

        if (msg.e === 'aggTrade' || msg.p !== undefined) this.broadcastPrice(room, priceFromAggTrade(msg));
        else if (msg.k) this.broadcast(room, tickFromKline(msg.k));
      } catch {
        /* un mensaje ilegible no debe tumbar el stream */
      }
    };

    ws.onerror = () => {
      /* el cierre viene después; se maneja allí para no duplicar reintentos */
    };

    ws.onclose = () => {
      if (room.ws !== ws) return; // cierre provocado por stopUpstream
      room.ws = null;
      if (!room.clients.size) return;

      // Una conexión que aguantó un buen rato y se cayó es un incidente nuevo,
      // no la continuación de una racha: se le devuelven sus tres intentos.
      if (room.connectedAt && Date.now() - room.connectedAt > WS_STABLE_MS) room.failures = 0;
      room.connectedAt = null;

      this.onWsFailure(room, 'WebSocket cerrado por el otro extremo');
    };
  }

  // Tras varios intentos fallidos se baja a sondeo en vez de insistir: si
  // Binance está bloqueando el WebSocket, reconectar cada segundo sólo empeora
  // las cosas. Pasados cinco minutos se vuelve a intentar el WebSocket.
  onWsFailure(room, reason) {
    room.failures += 1;

    if (room.failures >= 3) {
      room.degradedAt = Date.now();
      room.failures = 0; // el próximo intento de WebSocket parte de cero
      room.source = null;
      this.notifyStatus(room, 'degraded', `${reason}. Se pasa a sondeo periódico.`);
      this.ensureUpstream(room);
      return;
    }

    const delay = Math.min(1000 * 2 ** (room.failures - 1), MAX_BACKOFF_MS);
    this.notifyStatus(room, 'reconnecting', `${reason}. Reintento en ${Math.round(delay / 1000)} s.`);
    room.retryTimer = setTimeout(() => {
      if (room.clients.size) this.startWebSocket(room);
    }, delay);
    room.retryTimer.unref?.();
  }

  notifyStatus(room, state, message) {
    for (const client of room.clients) {
      try {
        client.send('status', { symbol: room.symbol, interval: room.interval, state, source: room.source, message });
      } catch {
        room.clients.delete(client);
      }
    }
  }

  stats() {
    return [...this.rooms.values()].map((room) => ({
      symbol: room.symbol,
      interval: room.interval,
      clients: room.clients.size,
      source: room.source,
      price: room.lastPrice ? room.lastPrice.price : null,
    }));
  }

  closeAll() {
    for (const room of this.rooms.values()) {
      if (room.closeTimer) clearTimeout(room.closeTimer);
      for (const client of room.clients) {
        try {
          client.close();
        } catch {
          /* ya cerrado */
        }
      }
      this.stopUpstream(room);
    }
    this.rooms.clear();
  }
}

// Adaptador SSE sobre una respuesta de Express.
function sseClient(res, { heartbeatMs = HEARTBEAT_MS } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    // Nginx bufferiza por defecto y un stream bufferizado no llega nunca.
    'X-Accel-Buffering': 'no',
  });
  res.write(': conectado\n\n');

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  return {
    send(event, data) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      clearInterval(heartbeat);
      try {
        res.end();
      } catch {
        /* ya cerrada */
      }
    },
    onGone(fn) {
      res.on('close', () => {
        clearInterval(heartbeat);
        fn();
      });
    },
  };
}

module.exports = { MarketStream, sseClient, tickFromKline, tickFromCandle, priceFromAggTrade, HEARTBEAT_MS };
