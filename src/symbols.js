'use strict';

// Lista de criptomonedas principales para el desplegable.
//
// Es una lista fija y no la que devuelve Binance: su catálogo tiene más de dos
// mil pares y la mayoría son ilíquidos o exóticos. Estos son los pares contra
// USDT que alguien querría mirar, ordenados por relevancia dentro de cada
// grupo. El campo `symbol` es lo que entiende la API; `name` lo que lee una
// persona.
//
// Una lista fija envejece: un par puede dejar de cotizar o cambiar de ticker
// (MATIC pasó a POL en 2024). Por eso, cuando hay red, se contrasta con
// Binance y los que ya no existen se marcan como no disponibles en vez de
// dejar que el usuario elija algo que devolverá un error.

const { fetchJson } = require('./http');
const { TtlCache } = require('./cache');
const { BINANCE_API } = require('./klines');

const CATALOG = [
  { symbol: 'BTCUSDT', name: 'Bitcoin', group: 'Principales' },
  { symbol: 'ETHUSDT', name: 'Ethereum', group: 'Principales' },
  { symbol: 'BNBUSDT', name: 'BNB', group: 'Principales' },
  { symbol: 'SOLUSDT', name: 'Solana', group: 'Principales' },
  { symbol: 'XRPUSDT', name: 'XRP', group: 'Principales' },
  { symbol: 'ADAUSDT', name: 'Cardano', group: 'Principales' },
  { symbol: 'DOGEUSDT', name: 'Dogecoin', group: 'Principales' },
  { symbol: 'TRXUSDT', name: 'TRON', group: 'Principales' },

  { symbol: 'AVAXUSDT', name: 'Avalanche', group: 'Capa 1' },
  { symbol: 'DOTUSDT', name: 'Polkadot', group: 'Capa 1' },
  { symbol: 'TONUSDT', name: 'Toncoin', group: 'Capa 1' },
  { symbol: 'NEARUSDT', name: 'NEAR', group: 'Capa 1' },
  { symbol: 'APTUSDT', name: 'Aptos', group: 'Capa 1' },
  { symbol: 'SUIUSDT', name: 'Sui', group: 'Capa 1' },
  { symbol: 'ATOMUSDT', name: 'Cosmos', group: 'Capa 1' },
  { symbol: 'LTCUSDT', name: 'Litecoin', group: 'Capa 1' },
  { symbol: 'BCHUSDT', name: 'Bitcoin Cash', group: 'Capa 1' },
  { symbol: 'ETCUSDT', name: 'Ethereum Classic', group: 'Capa 1' },
  { symbol: 'XLMUSDT', name: 'Stellar', group: 'Capa 1' },

  { symbol: 'LINKUSDT', name: 'Chainlink', group: 'Capa 2 y DeFi' },
  { symbol: 'ARBUSDT', name: 'Arbitrum', group: 'Capa 2 y DeFi' },
  { symbol: 'OPUSDT', name: 'Optimism', group: 'Capa 2 y DeFi' },
  { symbol: 'POLUSDT', name: 'Polygon (POL)', group: 'Capa 2 y DeFi' },
  { symbol: 'UNIUSDT', name: 'Uniswap', group: 'Capa 2 y DeFi' },
  { symbol: 'INJUSDT', name: 'Injective', group: 'Capa 2 y DeFi' },
  { symbol: 'FILUSDT', name: 'Filecoin', group: 'Capa 2 y DeFi' },

  { symbol: 'SHIBUSDT', name: 'Shiba Inu', group: 'Memes' },
  { symbol: 'PEPEUSDT', name: 'Pepe', group: 'Memes' },
  { symbol: 'WIFUSDT', name: 'dogwifhat', group: 'Memes' },
];

const cache = new TtlCache({ ttlMs: 3_600_000, maxEntries: 4 });

function listSymbols() {
  return CATALOG.map((s) => ({ ...s }));
}

function isKnown(symbol) {
  return CATALOG.some((s) => s.symbol === symbol);
}

function groups() {
  const out = [];
  for (const item of CATALOG) {
    let group = out.find((g) => g.name === item.group);
    if (!group) {
      group = { name: item.group, symbols: [] };
      out.push(group);
    }
    group.symbols.push(item);
  }
  return out;
}

// Contraste con Binance. Su endpoint devuelve 400 si CUALQUIER símbolo de la
// lista no existe, así que un solo par retirado dejaría sin verificar a los
// demás: en ese caso se sirve el catálogo tal cual y se dice que no se pudo
// comprobar. Prefiero un desplegable sin verificar a un desplegable vacío.
async function verifySymbols({ demo = false } = {}) {
  if (demo) return { symbols: listSymbols(), verified: false, reason: 'modo demo' };

  try {
    return await cache.wrap(
      'exchange-info',
      async () => {
        const query = JSON.stringify(CATALOG.map((s) => s.symbol));
        const info = await fetchJson(`${BINANCE_API}/api/v3/exchangeInfo`, {
          searchParams: { symbols: query },
          timeoutMs: 8000,
          retries: 1,
        });

        const tradable = new Set(
          (info.symbols || []).filter((s) => s.status === 'TRADING').map((s) => s.symbol)
        );

        return {
          symbols: listSymbols().map((s) => ({ ...s, available: tradable.has(s.symbol) })),
          verified: true,
        };
      },
      3_600_000,
      { serveStaleOnError: true }
    );
  } catch (err) {
    return { symbols: listSymbols(), verified: false, reason: err.message };
  }
}

module.exports = { CATALOG, listSymbols, isKnown, groups, verifySymbols };
