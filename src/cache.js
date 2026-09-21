'use strict';

// Caché TTL en memoria con "single flight": si dos peticiones piden la misma
// clave a la vez, sólo se dispara una llamada a la API externa y ambas esperan
// el mismo resultado. Las APIs de mercados de predicción tienen rate limits
// agresivos, así que esto importa más de lo que parece.

class TtlCache {
  constructor({ ttlMs = 30000, maxEntries = 500 } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.entries = new Map();
    this.inFlight = new Map();
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) return undefined;
    return entry.value;
  }

  // Valor guardado aunque haya caducado. Sirve para no dejar la vista en blanco
  // cuando la API de turno se cae: es preferible un precio de hace dos minutos,
  // etiquetado como viejo, que un error.
  getStale(key) {
    const entry = this.entries.get(key);
    return entry ? entry.value : undefined;
  }

  // Las entradas caducadas se conservan para poder servirlas como stale, así
  // que la caché ya no se vacía sola: sin un tope, un cliente que pidiera mil
  // símbolos inventados haría crecer el Map sin límite. Se desalojan las más
  // antiguas por orden de inserción, que en un Map es el de iteración.
  set(key, value, ttlMs = this.ttlMs) {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
    return value;
  }

  // Devuelve el valor cacheado o ejecuta producer(). Con
  // `serveStaleOnError` y un valor caducado en memoria, un fallo de producer
  // devuelve el valor viejo en vez de propagar el error; sin la opción, el
  // error se propaga tal cual (que es lo que quiere el analizador: prefiere
  // marcar la fuente como caída a mezclar precios de hace cinco minutos).
  async wrap(key, producer, ttlMs = this.ttlMs, { serveStaleOnError = false } = {}) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const promise = (async () => {
      try {
        const value = await producer();
        this.set(key, value, ttlMs);
        return value;
      } catch (err) {
        if (serveStaleOnError) {
          const stale = this.getStale(key);
          if (stale !== undefined) return stale;
        }
        throw err;
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
