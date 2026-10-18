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
  obtenerLiquidacion = null,
  observar = null,
  supervisar = null,
  refrescarMercado = null,
  fuentes = [],
  capital = 500,
  riesgoActual = null,
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
    ocupado: false,
    pnlRealizado: 0,
  };

  function anotar(entrada) {
    if (registro.anotar(entrada) === false) {
      parar();
      const err = new Error('No se pudo guardar el registro; bot detenido'); err.fatal = true; throw err;
    }
    if (alAnotar) alAnotar(entrada);
  }

  async function ciclo() {
    if (estado.ocupado) return { omitida: true, motivo: 'Hay una vuelta en curso' };
    estado.ocupado = true;
    let ahora = reloj();
    estado.vueltas++;

    try {
      // Resolver vencidas por el resultado oficial, aunque ya no aparezcan
      // en el listado de contratos abiertos.
      if (obtenerLiquidacion) for (const [ticker, pos] of estado.posiciones) {
        if (!(pos.vencimiento <= ahora || pos.pendienteLiquidacion)) continue;
        let result;
        try { result = await obtenerLiquidacion(ticker); }
        catch { anotar({ tipo: 'fallo_liquidacion', ticker }); continue; }
        if (result !== 'yes' && result !== 'no') continue;
        const pago = result === pos.lado ? pos.contratos : 0;
        const pnl = pago - pos.contratos * pos.precioEntrada - (pos.comisionEntrada ?? edge.comision(pos.contratos,pos.precioEntrada));
        anotar({ tipo: 'liquidacion', ticker, resultado: result, pago, pnl, papel: true });
        estado.posiciones.delete(ticker);
        estado.pnlRealizado += pnl;
      }
      // Cierre por presupuesto, independiente de predicción, listado y agente.
      if (refrescarMercado && riesgoActual && estado.posiciones.size) {
        const riesgoSalida = riesgoActual(reloj());
        const reservado = [...estado.posiciones.values()].reduce((s,p) => s + p.contratos*p.precioEntrada + (p.comisionEntrada ?? edge.comision(p.contratos,p.precioEntrada)),0);
        if (Number.isFinite(riesgoSalida.dailyRemaining) && reservado > riesgoSalida.dailyRemaining) {
          for (const pos of estado.posiciones.values()) {
            if (pos.vencimiento <= reloj()) continue;
            try {
              const m = await refrescarMercado({ ticker: pos.ticker });
              revisarSalidas({ lista: [m], prediccion: null, precio: null, ahora: reloj(), limites, limitesPara, anotar, estado, forzar: true });
            } catch (err) { if (err.fatal) throw err; anotar({ tipo: 'fallo_salida_riesgo', ticker: pos.ticker }); }
          }
        }
      }
      if (supervisar) await supervisar();
      const { mercados } = await obtenerMercados();
      if (!Array.isArray(mercados)) throw new Error('Lista de mercados inválida');
      const lista = mercados;

      const prediccion = await obtenerPrediccion();
      const precio = await obtenerPrecio();
      if (!Number.isFinite(precio) || precio <= 0) throw new Error('Precio del activo inválido');
      ahora = reloj();
      // Gestionar salidas antes del agente: la búsqueda/contexto no bloquea cierres.
      if (refrescarMercado) for (const pos of estado.posiciones.values()) {
        if (pos.vencimiento <= ahora) continue;
        try {
          const i = lista.findIndex(m => m.ticker === pos.ticker);
          const fresh = await refrescarMercado(i >= 0 ? lista[i] : { ticker: pos.ticker });
          if (i >= 0) lista[i] = fresh; else lista.push(fresh);
        } catch {
          const i = lista.findIndex(m => m.ticker === pos.ticker);
          if (i >= 0) lista[i] = { ...lista[i], libro: {}, bookAt: null };
          anotar({ tipo: 'fallo_libro_salida', ticker: pos.ticker });
        }
      }
      const salidas = revisarSalidas({ lista, prediccion, precio, ahora: reloj(), limites, limitesPara, anotar, estado });
      const vetos = await vetosMod.recoger(fuentes, { mercados: lista, ahora: reloj() });
      ahora = reloj();

      const resumen = { vueltas: estado.vueltas, vistos: lista.length, operables: 0, vetados: 0, salidas, vetos: vetos.length };
      const riesgo = riesgoActual ? riesgoActual(ahora) : null;
      if (riesgo && (['capital','dailyRemaining','maxPerTrade'].some(k=>!Number.isFinite(riesgo[k])||riesgo[k]<0) || riesgo.capital <= 0)) throw new Error('Capital de riesgo inválido');

      for (let m of lista) {
        // Nueva lectura después de la latencia del análisis; sin libro no hay fill.
        if (refrescarMercado && !estado.posiciones.has(m.ticker)) {
          try { m = await refrescarMercado(m); }
          catch { m = { ...m, libro: {} }; }
        }
        const precioDecision = refrescarMercado ? await obtenerPrecio() : precio;
        ahora = reloj();
        const propios = limitesPara ? { ...limites, ...limitesPara(m) } : limites;
        const reservado = [...estado.posiciones.values()].reduce((sum, p) => sum + p.contratos * p.precioEntrada + (p.comisionEntrada ?? edge.comision(p.contratos, p.precioEntrada)), 0);
        const disponible = Math.max(0, (riesgo ? riesgo.capital : capital) + Math.min(estado.pnlRealizado, riesgo ? 0 : Infinity) - reservado);
        const cruda = edge.evaluarMercado(m, prediccion, { precio: precioDecision, capital: disponible, ahora, limites: propios });
        if (cruda.operar && cruda.coste + cruda.comision > disponible) {
          cruda.operar = false;
          cruda.motivo = 'Capital disponible insuficiente, incluidas comisiones';
        }
        if (riesgo && cruda.operar) {
          const budget=Math.max(0,Math.min(disponible,riesgo.maxPerTrade,riesgo.dailyRemaining-reservado));
          let count=Math.min(cruda.contratos,Math.floor(budget/cruda.precio));
          while(count>0&&count*cruda.precio+edge.comision(count,cruda.precio)>budget)count--;
          if(riesgo.blocked||!count){cruda.operar=false;cruda.motivo=riesgo.blocked||'Presupuesto de riesgo diario agotado, incluidas posiciones abiertas';}
          else{cruda.contratos=count;cruda.coste=Number((count*cruda.precio).toFixed(2));cruda.comision=edge.comision(count,cruda.precio);cruda.ev=edge.valorEsperado({p:cruda.probabilidadLado,precio:cruda.precio,contratos:count}).ev;cruda.evTotal=Number((count*cruda.ev).toFixed(2));}
        }
        const decision = vetosMod.aplicar({ ...cruda }, vetos, { mercado: m, ahora });
        if (prediccion.bloqueoEntradas) { decision.operar = false; decision.motivo = prediccion.bloqueoEntradas; }
        if (refrescarMercado && (!Number.isFinite(m.bookAt) || ahora - m.bookAt > 10000 || m.bookAt > ahora)) {
          decision.operar = false; decision.motivo = 'Libro ausente o atrasado';
        }
        if (observar) await observar({ mercado: m, prediccion, precio: precioDecision, decision, cruda, ahora });

        if (decision.operar) resumen.operables++;
        if (decision.vetado) resumen.vetados++;

        anotar({
          tipo: 'decision',
          ticker: m.ticker,
          vence: new Date(m.vencimiento).toISOString(),
          precio: precioDecision,
          mercado: { yesBid: m.yesBid, yesAsk: m.yesAsk },
          motivoSinVeto: cruda.motivo || null,
          fuente: prediccion.fuente || 'no declarada',
          ...decision,
        });

        // Cartera de mentira: se apunta lo que se habría comprado.
        if (decision.operar && !estado.posiciones.has(m.ticker)) {
          anotar({ tipo: 'entrada', ticker: m.ticker, lado: decision.lado, contratos: decision.contratos, precio: decision.precio, comisionEntrada: decision.comision, vencimiento: m.vencimiento, papel: true });
          estado.posiciones.set(m.ticker, {
            ticker: m.ticker,
            lado: decision.lado,
            contratos: decision.contratos,
            precioEntrada: decision.precio,
            abiertaEn: ahora,
            vencimiento: m.vencimiento,
            comisionEntrada: decision.comision,
          });
        }
      }

      estado.fallosSeguidos = 0;
      estado.ultimoError = null;
      anotar({ tipo: 'vuelta', ...resumen });
      return resumen;
    } catch (err) {
      estado.fallosSeguidos++;
      estado.ultimoError = err.message;
      try { anotar({ tipo: 'fallo', mensaje: err.message, seguidos: estado.fallosSeguidos }); }
      catch { parar(); return { error: err.message, detenido: true }; }

      // Un fallo suelto es red. Cinco seguidos es algo roto, y seguir girando
      // en vacío sólo sirve para llenar el cuaderno de ruido.
      if (estado.fallosSeguidos >= FALLOS_SEGUIDOS_MAX) {
        anotar({ tipo: 'parada', motivo: `${estado.fallosSeguidos} vueltas seguidas fallando: ${err.message}` });
        // Con posiciones pendientes se conserva el supervisor de liquidaciones.
        if (!estado.posiciones.size && !supervisar) parar();
      }
      return { error: err.message, fallosSeguidos: estado.fallosSeguidos };
    } finally {
      estado.ocupado = false;
    }
  }

  function arrancar() {
    if (estado.corriendo) return;
    estado.corriendo = true;
    const tic = async () => {
      if (!estado.corriendo) return;
      await ciclo();
      if (!estado.corriendo) return;
      // El temporizador va REFERENCIADO, y es justo lo contrario de lo que
      // ponía aquí. Llevaba un `unref()` con el razonamiento de que un reloj
      // pendiente no debiera impedir que el proceso termine — pero un
      // temporizador sin referencia no mantiene vivo el bucle de eventos de
      // Node, así que el proceso se moría solo en cuanto acababa la primera
      // vuelta. Un bucle pensado para llevar días encendido duraba una vuelta.
      //
      // No hacía ninguna falta: `parar()` ya hace `clearTimeout`, que es la
      // forma correcta de dejar terminar el proceso.
      //
      // No lo cazó ninguna prueba porque las pruebas llaman a `ciclo()` a mano
      // y el propio corredor de tests mantiene vivo el proceso. Sólo se ve
      // ejecutando el servicio de verdad.
      estado.temporizador = setTimeout(tic, cadaMs);
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
function revisarSalidas({ lista, prediccion, precio, ahora, limites, limitesPara = null, anotar, estado, forzar = false }) {
  let salidas = 0;

  for (const [ticker, pos] of estado.posiciones) {
    const m = lista.find((x) => x.ticker === ticker);
    if ((m?.vencimiento ?? pos.vencimiento) <= ahora) {
      // Vencimiento no es liquidación. El capital sigue reservado hasta
      // recibir el resultado oficial; nunca inventar un pago por el reloj.
      if (!pos.pendienteLiquidacion) {
        anotar({ tipo: 'pendiente_liquidacion', ticker, lado: pos.lado, contratos: pos.contratos, papel: true });
        pos.pendienteLiquidacion = true;
      }
      continue;
    }
    if (!m) continue;
    if (m.bookAt != null && (ahora - m.bookAt > 10000 || m.bookAt > ahora)) continue;

    const propios = limitesPara ? { ...limites, ...limitesPara(m) } : limites;
    let r = edge.evaluarSalida(pos, m, prediccion, { precio, ahora, limites: propios });
    if (forzar) {
      const bid = pos.lado === 'yes' ? m.yesBid : m.noBid;
      const qty = m.libro?.[pos.lado === 'yes' ? 'yesBid' : 'noBid'];
      const count = Number.isFinite(qty) ? Math.min(pos.contratos, Math.floor(qty * (propios.fraccionDelLibro ?? edge.LIMITES.fraccionDelLibro))) : 0;
      r = { salir: bid > 0 && bid < 1 && count > 0, contratos: count, precio: bid, motivo: 'Reducir exposición al presupuesto diario disponible' };
    }
    if (!r.salir) continue;

    const feeEntrada = (pos.comisionEntrada ?? edge.comision(pos.contratos, pos.precioEntrada)) * r.contratos / pos.contratos;
    const pnl = (r.precio - pos.precioEntrada) * r.contratos - feeEntrada - edge.comision(r.contratos, r.precio);
    anotar({
      tipo: 'salida', ticker, lado: pos.lado, contratos: r.contratos,
      precioEntrada: pos.precioEntrada, precio: r.precio, motivo: r.motivo, pnl, comisionEntradaAsignada: feeEntrada, papel: true,
    });
    if (r.contratos >= pos.contratos) estado.posiciones.delete(ticker);
    else { pos.comisionEntrada = (pos.comisionEntrada ?? edge.comision(pos.contratos, pos.precioEntrada)) - feeEntrada; pos.contratos -= r.contratos; }
    salidas++;
    estado.pnlRealizado = (estado.pnlRealizado || 0) + pnl;
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
      posiciones.set(e.ticker, { ticker: e.ticker, lado: e.lado, contratos: e.contratos, precioEntrada: e.precio, abiertaEn: Date.parse(e.t) || 0, comisionEntrada: e.comisionEntrada, vencimiento: e.vencimiento });
    } else if (e.tipo === 'pendiente_liquidacion' && posiciones.has(e.ticker)) {
      posiciones.get(e.ticker).pendienteLiquidacion = true;
    } else if (e.tipo === 'salida' && posiciones.has(e.ticker) && e.contratos < posiciones.get(e.ticker).contratos) {
      const p = posiciones.get(e.ticker);
      p.comisionEntrada = (p.comisionEntrada ?? edge.comision(p.contratos, p.precioEntrada)) - (e.comisionEntradaAsignada ?? 0);
      p.contratos -= e.contratos;
    } else if (e.tipo === 'salida' || e.tipo === 'vencida' || e.tipo === 'liquidacion') {
      posiciones.delete(e.ticker);
    }
  }
  return posiciones;
}

module.exports = { crearBucle, reconstruir, revisarSalidas, FALLOS_SEGUIDOS_MAX };
