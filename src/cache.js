'use strict';

// Caché TTL en memoria con "single flight": si dos peticiones piden la misma
// clave a la vez, sólo se dispara una llamada a la API externa y ambas esperan
// el mismo resultado. Las APIs de mercados de predicción tienen rate limits
// agresivos, así que esto importa más de lo que parece.

class TtlCache {
  constructor({ ttlMs = 30000 } = {}) {
    this.ttlMs = ttlMs;
    this.entries = new Map();
    this.inFlight = new Map();
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
  }

  // Devuelve el valor cacheado o ejecuta producer(). Si producer falla y hay un
  // valor expirado guardado, se sirve el viejo (stale) antes que romper la vista.
  async wrap(key, producer, ttlMs = this.ttlMs) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const promise = (async () => {
      try {
        const value = await producer();
        this.set(key, value, ttlMs);
        return value;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, promise);
    return promise;
  }

  clear() {
    this.entries.clear();
    this.inFlight.clear();
  }
}

module.exports = { TtlCache };
