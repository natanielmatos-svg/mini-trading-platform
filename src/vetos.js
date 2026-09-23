'use strict';

// El freno del agente. Sólo sabe decir que NO.
//
// Ésta es la pieza que hace segura toda la arquitectura, y su valor está en lo
// que NO puede hacer: no existe ningún camino en este archivo que convierta un
// rechazo en una operación. `aplicar` recibe una decisión y devuelve la misma o
// una peor. Nunca mejor.
//
// Eso no es una promesa del prompt, que se puede sortear. Es la forma del tipo:
// una fuente de vetos devuelve una lista de vetos, y no hay ningún sitio donde
// poner un «sí». Aunque el modelo conteste «COMPRA TODO», aunque el texto de un
// mercado lleve una inyección, aunque la fuente se vuelva loca: el peor caso es
// que no se opere nada. Se pierde oportunidad, nunca dinero.
//
// Por eso el agente puede leer texto que no controlamos —reglas de contratos,
// noticias, calendarios— sin que eso sea un agujero.

/**
 * Un veto.
 *
 * @param fuente  quién lo pone, para poder discutirlo después
 * @param motivo  en una frase, legible en el registro
 * @param alcance 'todo' | { serie } | { ticker }
 * @param hasta   timestamp opcional: los vetos caducan, si no se acumulan
 */
function veto({ fuente, motivo, alcance = 'todo', hasta = null }) {
  return { fuente: String(fuente || 'desconocida'), motivo: String(motivo || 'sin motivo'), alcance, hasta };
}

function vigente(v, ahora) {
  return !Number.isFinite(v.hasta) || v.hasta > ahora;
}

// ¿Este veto alcanza a este mercado? Un veto sin alcance concreto los alcanza a
// todos: es lo prudente, porque quien escribe «hay dato de empleo en 20 min» no
// está pensando en tickers.
function alcanza(v, mercado) {
  if (!v.alcance || v.alcance === 'todo') return true;
  if (v.alcance.ticker) return mercado && mercado.ticker === v.alcance.ticker;
  if (v.alcance.serie) return mercado && String(mercado.ticker || '').startsWith(v.alcance.serie);
  return true;
}

/**
 * Aplica los vetos a una decisión.
 *
 * Devuelve la decisión intacta si nada la alcanza, y una decisión de NO operar
 * si algo la alcanza. No hay tercera salida.
 */
function aplicar(decision, vetos, { mercado = null, ahora = Date.now() } = {}) {
  const lista = (Array.isArray(vetos) ? vetos : []).filter((v) => v && vigente(v, ahora) && alcanza(v, mercado));
  if (!lista.length) return decision;

  // Aunque la decisión ya fuera negativa se anota el veto: para la autopsia
  // importa saber que además estaba vetado.
  return {
    ...decision,
    operar: false,
    vetado: true,
    vetos: lista,
    motivo: lista.length === 1
      ? `vetado por ${lista[0].fuente}: ${lista[0].motivo}`
      : `vetado por ${lista.length} motivos: ${lista.map((v) => `${v.fuente} (${v.motivo})`).join('; ')}`,
  };
}

/**
 * Recoge los vetos de todas las fuentes.
 *
 * Una fuente que falla NO se ignora: se convierte en un veto. No se puede
 * distinguir «no hay nada que avisar» de «no he podido comprobarlo», y tratar
 * lo segundo como lo primero es exactamente el fallo que uno lamenta después.
 * Se prefiere perder la operación.
 */
async function recoger(fuentes, contexto = {}) {
  const todos = [];

  for (const fuente of fuentes || []) {
    if (!fuente || typeof fuente.vetos !== 'function') continue;
    try {
      const r = await fuente.vetos(contexto);
      for (const v of Array.isArray(r) ? r : []) {
        if (v && v.motivo) todos.push(veto({ ...v, fuente: v.fuente || fuente.nombre }));
      }
    } catch (err) {
      todos.push(veto({
        fuente: fuente.nombre || 'desconocida',
        motivo: `no se pudo consultar (${err.message}); se prefiere no operar a operar a ciegas`,
      }));
    }
  }

  return todos;
}

/**
 * El interruptor de parada del operador: un archivo que se edita a mano.
 *
 * No necesita modelo, ni red, ni que nada funcione. Es la fuente que tiene que
 * seguir existiendo cuando todas las demás fallen, y por eso es la primera que
 * se escribió: `echo '[{"motivo":"para"}]' > vetos.json` detiene el bot.
 */
function fuenteArchivo(ruta, fs = require('node:fs')) {
  return {
    nombre: 'operador',
    async vetos() {
      let crudo;
      try {
        crudo = fs.readFileSync(ruta, 'utf8');
      } catch (err) {
        // Que no haya archivo es el caso normal: ningún veto.
        if (err.code === 'ENOENT') return [];
        throw err;
      }

      const datos = JSON.parse(crudo);
      const lista = Array.isArray(datos) ? datos : [datos];
      return lista.filter((v) => v && v.motivo);
    },
  };
}

module.exports = { veto, aplicar, recoger, fuenteArchivo, alcanza, vigente };
