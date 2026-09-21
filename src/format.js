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

function formatPrice(price) {
  if (!Number.isFinite(price)) return '—';
  const d = priceDecimals(price);
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
  return `${days} d ${hours % 24} h`;
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

const API = { priceDecimals, formatPrice, num, formatPercent, formatDuration, formatClock };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else globalThis.Format = API;
})();
