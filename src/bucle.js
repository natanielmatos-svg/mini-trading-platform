'use strict';

// El proceso que corre solo: mira, decide, anota y vuelve a mirar.
//
// Lo que hace en cada vuelta:
//
//   1. Recoge los vetos de todas las fuentes. PRIMERO, antes de calcular nada:
//      si el operador ha parado el bot o el agente ha visto un dato macro, no
//      hace falta ni pedir los mercados.
//   2. Pide los mercados y la predicción.
//   3. Decide mercado a mercado, aplica los vetos y lo anota TODO, se opere o
//      no. Los rechazos son la mitad interesante del cuaderno.
//   4. Revisa las posiciones abiertas por si toca salir.
//
// Lo que NO hace: enviar órdenes. Lleva una cartera de mentira —lo que habría
// comprado— y ése es exactamente el paso previo a poner dinero: se deja correr
// unos días y se mira el cuaderno.
//
// DOS REGLAS DE ROBUSTEZ, porque esto está pensado para llevar días encendido:
// una vuelta que falla no puede tumbar el proceso, y un fallo repetido no puede
// pasar desapercibido. Los fallos se cuentan, se anotan y, si se encadenan, el
// bucle se para solo en vez de seguir girando en vacío.

const edge = require('./kalshi-edge');
const vetosMod = require('./vetos');
const registroMod = require('./registro');

const FALLOS_SEGUIDOS_MAX = 5;

/**
 * @param obtenerMercados  () => { mercados: [...] }
 * @param obtenerPrediccion () => { horizontes: [...] }  (cara: se cachea fuera)
 * @param obtenerPrecio    () => number
 */
function crearBucle({
  obtenerMercados,
  obtenerPrediccion,
  obtenerPrecio,
  fuentes = [],
  capital = 500,
  limites = {},
  cadaMs = 60_000,
  // Límites por mercado. Existe porque el ruido de base NO es una constante
  // global: se declara al aprobar cada serie, y usar el de por defecto cuando
  // hay uno declarado sería operar con un número distinto del que alguien
  // firmó.
  limitesPara = null,
  registro = registroMod,
  reloj = Date.now,
  alAnotar = null,
} = {}) {
  const estado = {
    vueltas: 0,
    fallosSeguidos: 0,
    ultimoError: null,
    posiciones: new Map(),   // ticker -> { lado, contratos, precioEntrada, abiertaEn }
    corriendo: false,
    temporizador: null,
  };

  function anotar(entrada) {
    registro.anotar(entrada);
    if (alAnotar) alAnotar(entrada);
  }

  async function ciclo() {
    const ahora = reloj();
    estado.vueltas++;

    try {
      const { mercados } = await obtenerMercados();
      const lista = Array.isArray(mercados) ? mercados : [];

      // Los vetos, con los mercados a la vista: hay fuentes que vetan por
      // serie y necesitan saber qué series hay delante.
      const vetos = await vetosMod.recoger(fuentes, { mercados: lista, ahora });

      const prediccion = await obtenerPrediccion();
      const precio = await obtenerPrecio();

      const resumen = { vueltas: estado.vueltas, vistos: lista.length, operables: 0, vetados: 0, salidas: 0, vetos: vetos.length };

      for (const m of lista) {
        const propios = limitesPara ? { ...limites, ...limitesPara(m) } : limites;
        const cruda = edge.evaluarMercado(m, prediccion, { precio, capital, ahora, limites: propios });
        const decision = vetosMod.aplicar(cruda, vetos, { mercado: m, ahora });

        if (decision.operar) resumen.operables++;
        if (decision.vetado) resumen.vetados++;

        anotar({
          tipo: 'decision',
          ticker: m.ticker,
          vence: new Date(m.vencimiento).toISOString(),
          precio,
          mercado: { yesBid: m.yesBid, yesAsk: m.yesAsk },
          ...decision,
        });

        // Cartera de mentira: se apunta lo que se habría comprado.
        if (decision.operar && !estado.posiciones.has(m.ticker)) {
          estado.posiciones.set(m.ticker, {
            ticker: m.ticker,
            lado: decision.lado,
            contratos: decision.contratos,
            precioEntrada: decision.precio,
            abiertaEn: ahora,
          });
          anotar({ tipo: 'entrada', ticker: m.ticker, lado: decision.lado, contratos: decision.contratos, precio: decision.precio, papel: true });
        }
      }

      resumen.salidas = revisarSalidas({ lista, prediccion, precio, ahora, limites, limitesPara, anotar, estado });

      estado.fallosSeguidos = 0;
      estado.ultimoError = null;
      anotar({ tipo: 'vuelta', ...resumen });
      return resumen;
    } catch (err) {
      estado.fallosSeguidos++;
      estado.ultimoError = err.message;
      anotar({ tipo: 'fallo', mensaje: err.message, seguidos: estado.fallosSeguidos });

      // Un fallo suelto es red. Cinco seguidos es algo roto, y seguir girando
      // en vacío sólo sirve para llenar el cuaderno de ruido.
      if (estado.fallosSeguidos >= FALLOS_SEGUIDOS_MAX) {
        anotar({ tipo: 'parada', motivo: `${estado.fallosSeguidos} vueltas seguidas fallando: ${err.message}` });
        parar();
      }
      return { error: err.message, fallosSeguidos: estado.fallosSeguidos };
    }
  }

  function arrancar() {
    if (estado.corriendo) return;
    estado.corriendo = true;
    const tic = async () => {
      if (!estado.corriendo) return;
      await ciclo();
      if (!estado.corriendo) return;
      estado.temporizador = setTimeout(tic, cadaMs);
      // Un temporizador pendiente no debe impedir que el proceso termine si
      // alguien lo para: el bucle manda sobre el reloj, no al revés.
      if (estado.temporizador.unref) estado.temporizador.unref();
    };
    tic();
  }

  function parar() {
    estado.corriendo = false;
    if (estado.temporizador) clearTimeout(estado.temporizador);
    estado.temporizador = null;
  }

  return { ciclo, arrancar, parar, estado };
}

// Las salidas se revisan aunque haya vetos: un veto impide ABRIR, no obliga a
// quedarse dentro. Confundir las dos cosas dejaría posiciones atrapadas justo
// cuando algo va mal, que es cuando más importa poder salir.
function revisarSalidas({ lista, prediccion, precio, ahora, limites, limitesPara = null, anotar, estado }) {
  let salidas = 0;

  for (const [ticker, pos] of estado.posiciones) {
    const m = lista.find((x) => x.ticker === ticker);
    if (!m) continue;

    if (m.vencimiento <= ahora) {
      estado.posiciones.delete(ticker);
      anotar({ tipo: 'vencida', ticker, lado: pos.lado, contratos: pos.contratos, papel: true });
      continue;
    }

    const propios = limitesPara ? { ...limites, ...limitesPara(m) } : limites;
    const r = edge.evaluarSalida(pos, m, prediccion, { precio, ahora, limites: propios });
    if (!r.salir) continue;

    estado.posiciones.delete(ticker);
    salidas++;
    anotar({
      tipo: 'salida', ticker, lado: pos.lado, contratos: r.contratos,
      precioEntrada: pos.precioEntrada, precio: r.precio, motivo: r.motivo, papel: true,
    });
  }

  return salidas;
}

/**
 * Rehace la cartera de mentira desde el cuaderno.
 *
 * Un proceso que lleva días encendido se reinicia: sin esto, al arrancar se
 * creería plano y volvería a «comprar» lo que ya tenía.
 */
function reconstruir(entradas) {
  const posiciones = new Map();
  for (const e of entradas) {
    if (e.tipo === 'entrada') {
      posiciones.set(e.ticker, { ticker: e.ticker, lado: e.lado, contratos: e.contratos, precioEntrada: e.precio, abiertaEn: Date.parse(e.t) || 0 });
    } else if (e.tipo === 'salida' || e.tipo === 'vencida') {
      posiciones.delete(e.ticker);
    }
  }
  return posiciones;
}

module.exports = { crearBucle, reconstruir, revisarSalidas, FALLOS_SEGUIDOS_MAX };
