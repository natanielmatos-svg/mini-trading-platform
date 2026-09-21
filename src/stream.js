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

const WS_BASE = process.env.BINANCE_WS || 'wss://stream.binance.com:9443/ws';
const HEARTBEAT_MS = 20_000;   // por debajo del proxy_read_timeout de Nginx
const LINGER_MS = 30_000;      // margen antes de cerrar el upstream sin clientes
const DEMO_TICK_MS = 2_000;
const POLL_MIN_MS = 5_000;
const MAX_BACKOFF_MS = 30_000;
const WS_RETRY_AFTER_MS = 5 * 60_000; // tras degradar a poll, reintentar el WS

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
    const payload = { symbol: room.symbol, interval: room.interval, source: room.source, ...tick };
    for (const client of room.clients) {
      try {
        client.send('kline', payload);
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
    if (room.retryTimer) clearTimeout(room.retryTimer);
    room.timer = null;
    room.retryTimer = null;
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
    const emit = () => {
      const [candle] = buildDemoCandles({ symbol: room.symbol, interval: room.interval, limit: 1, now: Date.now() });
      if (candle) this.broadcast(room, tickFromCandle(candle));
    };
    emit();
    room.timer = setInterval(emit, DEMO_TICK_MS);
    room.timer.unref?.();
  }

  startPolling(room) {
    const period = Math.max(Math.round(intervalMs(room.interval) / 60), POLL_MIN_MS);
    const emit = async () => {
      try {
        const { candles } = await getKlines({ symbol: room.symbol, interval: room.interval, limit: 2, demo: this.demo });
        const last = candles[candles.length - 1];
        if (last) this.broadcast(room, tickFromCandle(last));
      } catch (err) {
        this.notifyStatus(room, 'error', err.message);
      }
    };
    emit();
    room.timer = setInterval(emit, period);
    room.timer.unref?.();
  }

  startWebSocket(room) {
    const url = `${WS_BASE}/${room.symbol.toLowerCase()}@kline_${room.interval}`;
    let ws;

    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.onWsFailure(room, err.message);
      return;
    }

    room.ws = ws;

    ws.onopen = () => {
      room.failures = 0;
      this.notifyStatus(room, 'live', 'WebSocket de Binance conectado');
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
        if (msg && msg.k) this.broadcast(room, tickFromKline(msg.k));
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

module.exports = { MarketStream, sseClient, tickFromKline, tickFromCandle, HEARTBEAT_MS };
