'use strict';

// ¿Cuántos contratos hacen falta para saber si hay ventaja?
//
// Esta pregunta aparece antes que cualquier otra y casi nunca se hace. Se
// recogen datos hasta que «parece que va bien», se mira el porcentaje de
// aciertos y se decide. Pero un porcentaje sin su intervalo no distingue una
// estrategia ganadora de una perdedora, y con muestras pequeñas el intervalo
// es enorme: con 17 contratos y un 64,7% de aciertos, lo que de verdad se sabe
// es que el acierto está entre el 42% y el 87%. El equilibrio está en el 52%.
// O sea: no se sabe nada.
//
// Lo que este módulo calcula no es una predicción. Es el tamaño de muestra por
// debajo del cual NO hay que molestarse en concluir, y sirve para decidir si
// un plan tiene sentido ANTES de pasar semanas recogiendo datos.
//
// La trampa que evita: planificar con la tasa de aciertos medida. Esa tasa sale
// de una muestra corta y, peor, suele elegirse después de mirar los datos, así
// que es el número más optimista disponible. Planificar con él da el tamaño de
// muestra más pequeño posible, que es exactamente el error.

// Aproximación de Acklam al cuantil de la normal, la misma que ya usa
// `calibracion.js`. Se reutiliza en vez de duplicarla.
const { zNormal } = require('./calibracion');

/**
 * El acierto a partir del cual una compra deja de perder dinero.
 *
 * Comprando a `precio` y manteniendo a liquidación, cada contrato cuesta el
 * precio más la comisión y paga 1 si acierta. El equilibrio es, simplemente,
 * lo que cuesta.
 */
function equilibrio(precio, tasaComision = 0.07) {
  if (!(precio > 0) || !(precio < 1)) return null;
  const comision = Math.ceil(tasaComision * precio * (1 - precio) * 100) / 100;
  return { acierto: precio + comision, comision, precio };
}

/**
 * Intervalo de Wilson para una proporción.
 *
 * No el de Wald (p ± z·√(p(1−p)/n)): con muestras pequeñas o proporciones
 * cerca de los extremos, Wald se sale de [0,1] y da intervalos demasiado
 * estrechos, que es el error justo donde más daño hace.
 */
function intervalo(aciertos, casos, confianza = 0.95) {
  if (!(casos > 0) || !(aciertos >= 0) || aciertos > casos) return null;

  const z = zNormal(1 - (1 - confianza) / 2);
  const p = aciertos / casos;
  const d = 1 + (z * z) / casos;
  const centro = (p + (z * z) / (2 * casos)) / d;
  const semi = (z * Math.sqrt((p * (1 - p)) / casos + (z * z) / (4 * casos * casos))) / d;

  return { observado: p, bajo: Math.max(0, centro - semi), alto: Math.min(1, centro + semi), casos, confianza };
}

/**
 * Cuántos contratos hacen falta para distinguir `acierto` de `equilibrio`.
 *
 * Es la cuenta estándar de tamaño de muestra para una proporción contra un
 * valor de referencia. `potencia` es la probabilidad de detectar la ventaja si
 * de verdad existe: con 0,8, una de cada cinco veces no se detectaría aunque
 * estuviera ahí.
 *
 * Devuelve null cuando no hay ventaja que detectar: pedir el tamaño de muestra
 * para distinguir algo de sí mismo no tiene respuesta, y devolver un número
 * enorme invitaría a creer que con suficientes datos se demuestra cualquier
 * cosa.
 */
function contratosNecesarios({ acierto, equilibrio: eq, confianza = 0.95, potencia = 0.8 } = {}) {
  if (!(acierto > 0) || !(acierto < 1) || !(eq > 0) || !(eq < 1)) return null;

  const diferencia = Math.abs(acierto - eq);
  if (diferencia < 1e-9) return null;

  const za = zNormal(1 - (1 - confianza) / 2);
  const zb = zNormal(potencia);
  const n = ((za * Math.sqrt(eq * (1 - eq)) + zb * Math.sqrt(acierto * (1 - acierto))) / diferencia) ** 2;

  return Math.ceil(n);
}

/**
 * El cuadro completo: qué se sabe hoy y cuánto falta para saber algo.
 *
 * La pieza que más importa es `concluyente`. Mientras el intervalo cruce el
 * equilibrio, la muestra es compatible con perder dinero, y da igual lo bueno
 * que parezca el porcentaje.
 */
function diagnostico({ aciertos, casos, precio = 0.5, tasaComision = 0.07, confianza = 0.95, potencia = 0.8 } = {}) {
  const eq = equilibrio(precio, tasaComision);
  if (!eq) return { ok: false, reason: 'precio fuera de (0,1)' };

  const inter = intervalo(aciertos, casos, confianza);
  if (!inter) return { ok: false, reason: 'muestra no utilizable' };

  const gana = inter.bajo > eq.acierto;
  const pierde = inter.alto < eq.acierto;

  // Cuánto haría falta bajo varios supuestos de ventaja real. El medido va
  // primero y marcado, porque es el optimista y no debe usarse para planificar.
  const supuestos = [inter.observado, 0.60, 0.58, 0.56, 0.55, 0.54]
    .filter((p) => p > eq.acierto)
    .map((p) => ({
      acierto: p,
      medido: Math.abs(p - inter.observado) < 1e-9,
      ventajaPorContrato: p - eq.acierto,
      contratos: contratosNecesarios({ acierto: p, equilibrio: eq.acierto, confianza, potencia }),
    }));

  return {
    ok: true,
    equilibrio: eq,
    intervalo: inter,
    concluyente: gana || pierde,
    veredicto: gana ? 'la muestra excluye perder dinero'
      : pierde ? 'la muestra excluye ganar dinero'
      : 'la muestra es compatible con ganar Y con perder: no concluye nada',
    supuestos,
  };
}

module.exports = { equilibrio, intervalo, contratosNecesarios, diagnostico };
