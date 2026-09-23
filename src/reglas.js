'use strict';

// Contra qué liquida cada serie, y quién ha dicho que sí.
//
// Ésta es la respuesta a la pregunta que quedó abierta cuando se escribió el
// motor: Kalshi liquida contra SU índice y nosotros predecimos la mediana de
// cuatro exchanges. Si no son lo mismo, el error aparece justo en el strike,
// que es donde se opera.
//
// La regla: **una serie sin ficha aprobada por una persona no se opera.** El
// agente lee el reglamento y rellena la ficha, pero rellenar no es aprobar. Un
// modelo leyendo un PDF es una ayuda para encontrar la frase; la autoridad
// sobre dónde va el dinero es de quien pone el dinero.
//
// Por eso el veto es el estado POR DEFECTO. No hay que acordarse de activarlo:
// hay que acordarse de desactivarlo, una serie cada vez, mirándola.

const fs = require('node:fs');
const path = require('node:path');

const RUTA = process.env.KALSHI_SERIES || path.join(process.cwd(), 'datos', 'series.json');

function cargar(ruta = RUTA) {
  try {
    const datos = JSON.parse(fs.readFileSync(ruta, 'utf8'));
    return datos && typeof datos === 'object' ? datos : {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

function guardar(fichas, ruta = RUTA) {
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  fs.writeFileSync(ruta, JSON.stringify(fichas, null, 2) + '\n');
}

function anotarFicha(ficha, { ruta = RUTA } = {}) {
  if (!ficha || !ficha.serie) throw new Error('la ficha necesita una serie');
  const fichas = cargar(ruta);

  // Una ficha nueva NUNCA hereda la aprobación de la anterior. Si el reglamento
  // cambió —que es la razón de volver a leerlo— la aprobación de antes era
  // sobre otro texto.
  fichas[ficha.serie] = { ...ficha, aprobado: false, aprobadoPor: null, aprobadoEn: null };
  guardar(fichas, ruta);
  return fichas[ficha.serie];
}

/**
 * Una persona dice que sí, con su nombre y la fecha.
 *
 * Se exige `ruidoBase`: aprobar una serie es declarar cuánto puede separarse su
 * índice de nuestro precio, y ése es el número que convierte una ventaja en una
 * pérdida. Aprobar sin declararlo sería aprobar a ciegas.
 */
function aprobar(serie, { quien, ruidoBase, indice = null, ruta = RUTA } = {}) {
  const fichas = cargar(ruta);

  // Con `indice` se puede declarar a mano, sin pasar por el agente. La
  // autoridad es de quien pone el dinero: el modelo sólo ahorra leer el PDF, y
  // quien ya sabe contra qué liquida su serie no debería necesitar una clave de
  // API para poder operarla.
  const ficha = fichas[serie] || (indice ? { serie, indice, proveedor: '', composicion: '', hora: '', confianza: 'alta', cita: 'declarado a mano por el operador' } : null);
  if (!ficha) throw new Error(`no hay ficha de ${serie}: léela con «agente reglas» o declara --indice al aprobarla`);
  if (!quien) throw new Error('hace falta saber quién aprueba');
  if (!(ruidoBase >= 0)) throw new Error('hace falta declarar el ruido de base medido');

  fichas[serie] = { ...ficha, aprobado: true, aprobadoPor: quien, aprobadoEn: new Date().toISOString(), ruidoBase };
  guardar(fichas, ruta);
  return fichas[serie];
}

// La ficha que cubre a un ticker: la serie cuyo nombre lo prefija.
function fichaDe(ticker, fichas) {
  const t = String(ticker || '');
  let mejor = null;
  for (const [serie, ficha] of Object.entries(fichas)) {
    if (!t.startsWith(serie)) continue;
    // La más específica gana: KXBTCD antes que KXBTC.
    if (!mejor || serie.length > mejor.serie.length) mejor = { serie, ...ficha };
  }
  return mejor;
}

/**
 * La fuente de vetos: todo lo que no tenga ficha aprobada, fuera.
 *
 * No necesita modelo ni red. Es la que garantiza que el bot no opera una serie
 * que nadie ha mirado, aunque el agente esté caído y el escáner encuentre la
 * mejor ventaja de su vida.
 */
function fuenteReglas({ ruta = RUTA } = {}) {
  return {
    nombre: 'reglas',
    async vetos({ mercados = [] } = {}) {
      const fichas = cargar(ruta);
      const sinFicha = new Set();

      for (const m of mercados) {
        const f = fichaDe(m.ticker, fichas);
        if (!f) sinFicha.add(serieDe(m.ticker));
        else if (!f.aprobado) sinFicha.add(f.serie);
      }

      return [...sinFicha].map((serie) => ({
        fuente: 'reglas',
        alcance: { serie },
        motivo: `nadie ha aprobado contra qué liquida ${serie}: léela y apruébala antes de operarla`,
      }));
    },
  };
}

// Kalshi separa serie y resto con guiones. Para el veto basta el primer tramo.
function serieDe(ticker) {
  return String(ticker || '').split('-')[0] || String(ticker || '');
}

/**
 * El ruido de base declarado al aprobar, que es el que debe usar el motor.
 *
 * Sin ficha aprobada devuelve null, y quien llama decide: el escáner avisa y
 * usa el de por defecto, el bucle ni siquiera llega aquí porque el veto ya lo
 * paró.
 */
function ruidoBaseDe(ticker, { ruta = RUTA } = {}) {
  const f = fichaDe(ticker, cargar(ruta));
  return f && f.aprobado && Number.isFinite(f.ruidoBase) ? f.ruidoBase : null;
}

module.exports = { cargar, guardar, anotarFicha, aprobar, fuenteReglas, fichaDe, ruidoBaseDe, serieDe, RUTA };
