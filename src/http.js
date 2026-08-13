'use strict';

// Cliente HTTP mínimo sobre fetch nativo (Node >= 18) con timeout y reintentos.
// Los reintentos sólo aplican a fallos de red y errores 5xx / 429: un 4xx
// "normal" significa que la petición está mal formada y repetirla no ayuda.

class HttpError extends Error {
  constructor(message, { status = 0, url = '', body = '' } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

const DEFAULT_HEADERS = {
  accept: 'application/json',
  'user-agent': 'mini-trading-platform/prediction-analyzer',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(err) {
  if (err instanceof HttpError) {
    return err.status === 0 || err.status === 429 || err.status >= 500;
  }
  return true; // errores de red / abort
}

async function fetchJson(url, options = {}) {
  const {
    timeoutMs = 10000,
    retries = 2,
    backoffMs = 400,
    headers = {},
    searchParams = null,
  } = options;

  let target = url;
  if (searchParams) {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(searchParams)) {
      if (value === undefined || value === null || value === '') continue;
      qs.append(key, String(value));
    }
    const sep = target.includes('?') ? '&' : '?';
    target = `${target}${sep}${qs.toString()}`;
  }

  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(target, {
        headers: { ...DEFAULT_HEADERS, ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new HttpError(`HTTP ${res.status} en ${target}`, {
          status: res.status,
          url: target,
          body: body.slice(0, 400),
        });
      }

      return await res.json();
    } catch (err) {
      lastError = err instanceof HttpError
        ? err
        : new HttpError(`Fallo de red en ${target}: ${err.message}`, { url: target });

      if (attempt === retries || !isRetryable(lastError)) break;
      await sleep(backoffMs * 2 ** attempt);
    }
  }

  throw lastError;
}

module.exports = { fetchJson, HttpError };
