'use strict';

// Todo el módulo va dentro de una función. En Node da igual —cada archivo ya
// tiene su ámbito— pero en el navegador se carga con <script> y el ámbito es
// global: sin esto, dos módulos que declaren `const API` se pisan y el segundo
// no llega a definirse.
(function () {
// Formato de números para personas, compartido por el servidor y el navegador.
//
// Estaba repetido en tres sitios: el análisis de ruptura, el motor de señales y
// el gráfico. Tres copias del mismo `toLocaleString` acaban discrepando en los
// decimales, y en español además hay que acordarse de que el separador decimal
// es la coma: "2.931%" se lee como dos mil novecientos treinta y uno.

// Los decimales útiles dependen de la escala: 64321,5 y 0,00004312 no se
// escriben igual.
function priceDecimals(price) {
  const abs = Math.abs(Number(price));
  if (!(abs > 0)) return 2;
  if (abs >= 1000) return 1;
  if (abs >= 10) return 2;
  if (abs >= 1) return 4;
  return 6;
}

// `decimales` sólo lo pasa el titular en vivo, que usa un escalón más grueso
// que el resto de la interfaz a propósito: ver src/precio-vivo.js.
function formatPrice(price, decimales = null) {
  if (!Number.isFinite(price)) return '—';
  const d = Number.isInteger(decimales) ? decimales : priceDecimals(price);
  return price.toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function num(value, decimals = 2) {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString('es-ES', { maximumFractionDigits: decimals });
}

// Recibe una fracción (0,434), no un porcentaje ya multiplicado.
function formatPercent(fraction, decimals = 1) {
  if (!Number.isFinite(fraction)) return '—';
  return `${num(fraction * 100, decimals)}%`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'nada';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  if (hours < 24) return rest ? `${hours} h ${rest} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  // Sin las horas cuando son cero: "1 d 0 h" no lo dice nadie, y aparece justo
  // en el caso más habitual de todos, el de un día redondo.
  const resto = hours % 24;
  return resto ? `${days} d ${resto} h` : `${days} d`;
}

// Cuenta atrás mm:ss o h:mm:ss.
function formatClock(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '00:00';
  const total = Math.floor(ms / 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// Ventana de la vela en curso: cuándo abrió, cuándo cierra y cuánto le queda.
//
// Antes la cuenta atrás salía del análisis de ruptura, que se refresca cada
// uno o dos minutos: al cerrar una vela el resto se volvía negativo y el
// cronómetro se quedaba clavado en 00:00 hasta el siguiente refresco. Esto se
// calcula del reloj, así que nunca se queda viejo.
//
// Con `aperturaConocida` —la que dio Binance— se avanza desde ahí en saltos de
// un intervalo, que es exacto incluso para las semanas, que no empiezan en el
// epoch. Sin ella se usa el bucket del reloj, que vale para todo lo demás.
function candleWindow(now, stepMs, aperturaConocida = null, finDeSesion = null) {
  if (!(stepMs > 0)) return null;

  const open = Number.isFinite(aperturaConocida)
    ? aperturaConocida + Math.max(Math.floor((now - aperturaConocida) / stepMs), 0) * stepMs
    : Math.floor(now / stepMs) * stepMs;

  // En bolsa la última vela de la sesión se corta al cerrar el mercado: una
  // de una hora abierta a las 15:30 no dura hasta las 16:30 si se cierra a
  // las 16:00. En cripto no hay fin de sesión y esto no se usa.
  const finNatural = open + stepMs - 1;
  const close = Number.isFinite(finDeSesion) && finDeSesion < finNatural ? finDeSesion : finNatural;

  const duracion = Math.max(close - open + 1, 1);
  const elapsed = Math.min(Math.max((now - open) / duracion, 0), 1);

  return { open, close, remainingMs: Math.max(close - now + 1, 0), elapsed, recortada: close !== finNatural };
}

const API = { priceDecimals, formatPrice, num, formatPercent, formatDuration, formatClock, candleWindow };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else globalThis.Format = API;
})();
