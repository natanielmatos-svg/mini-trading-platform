'use strict';

// Todo el módulo va dentro de una función. En Node da igual —cada archivo ya
// tiene su ámbito— pero en el navegador se carga con <script> y el ámbito es
// global: sin esto, dos módulos que declaren lo mismo se pisan.
(function () {

// El precio en vivo, calmado para poder leerlo.
//
// El problema no era la latencia sino la resolución. Con BTC a 85.763,2 el
// último dígito vale 0,1 $ —un 0,00012% del precio— y a eso lo mueve cualquier
// operación suelta. Peor: lo que llega por `@aggTrade` es el precio de CADA
// operación ejecutada, que rebota entre la compra y la venta del libro aunque
// el mercado esté quieto. Diez repintados por segundo de un número cuyos
// últimos dígitos son ruido, cada uno con su destello de color, y el resultado
// es una pantalla que parece agitadísima cuando no pasa nada.
//
// Kalshi se ve quieto por lo contrario: cotiza de 0 a 100 ¢ con tick de 1 ¢,
// un 1% del rango. Sencillamente no puede enseñar ruido más fino.
//
// Aquí se hace lo mismo a la escala que toca, con dos piezas que hacen cosas
// distintas y las dos hacen falta. Medido sobre un flujo simulado de 10
// ticks/s durante un minuto:
//
//   · **El escalón** decide cuántos dígitos se enseñan. Redondear a un escalón
//     de entre el 0,001% y el 0,01% quita los dígitos que son ruido.
//   · **La banda** decide cuándo se repinta: el número no se mueve hasta que
//     el precio se aleja de lo que está puesto más que la banda.
//
// Al principio sólo puse el escalón, y en un mercado quieto seguía repintando
// 173 veces por minuto. El motivo: el rebote entre compra y venta es MÁS ANCHO
// que el escalón, así que cruzaba la frontera de redondeo en cada tick y el
// número cuantizado cambiaba igual. Redondear no quita un rebote que salta por
// encima del redondeo; la histéresis sí, porque mide contra lo que se está
// enseñando y no contra una rejilla fija.
//
// LO QUE NO SE TOCA: el precio que usa el ANÁLISIS. La distancia al nivel de
// ruptura, el ATR y las señales siguen con el precio crudo, tick a tick.
// Suavizar eso sería mentir sobre lo cerca que está de romper.

// Escalón de pantalla como fracción del precio. A 0,0001 el redondeo cae entre
// el 0,001% y el 0,01% según dónde quede la potencia de diez, que es el orden
// de la horquilla del libro: por debajo de eso no hay información, hay ruido.
const F = typeof module !== 'undefined' && module.exports ? require('./format') : globalThis.Format;

const OBJETIVO = 0.0001;

// Cuánto tiene que alejarse el precio de lo que está puesto para repintar.
// Por encima de la horquilla típica del libro, que es el ruido que se quiere
// quitar, y muy por debajo de cualquier movimiento que signifique algo.
const BANDA = 0.0005;

// Tope de repintados. El ojo no distingue más de unos pocos por segundo, y el
// destello necesita tiempo para verse.
const MIN_MS = 250;

// Todo se calcula sobre el EXPONENTE entero, no sobre el escalón: `10 ** -4`
// en coma flotante es 0,00009999999999999999, y de ahí salía un decimal de más
// y un precio cuantizado como 0,12345999999999999.
function exponente(price, objetivo = OBJETIVO) {
  if (!(price > 0)) return null;
  return Math.floor(Math.log10(price * objetivo));
}

// Se usan potencias de diez y no escalones 1-2-5 porque un precio que avanza
// de cinco en cinco no lo lee nadie: la gente espera decimales.
function escalon(price, objetivo = OBJETIVO) {
  const k = exponente(price, objetivo);
  return k === null ? null : 10 ** k;
}

// Los MISMOS decimales que el resto de la aplicación.
//
// Durante un tiempo el titular enseñaba menos —bitcoin en dólares enteros—
// para que el último dígito no bailara. Era resolver dos veces el mismo
// problema: la banda de histéresis ya impide repintar hasta que el precio se
// mueve un 0,05%, que en bitcoin son unos 43 dólares, así que el decimal no
// puede parpadear aunque esté. Lo único que conseguía era que el titular
// fuese el ÚNICO sitio de la pantalla con otra precisión que el gráfico, la
// tabla de predicción y los niveles de ruptura.
function decimales(price) {
  return F.priceDecimals(price);
}

// Redondear a los decimales que se enseñan ES cuantizar, y toFixed no arrastra
// el error de las potencias de diez negativas.
function cuantizar(price) {
  if (!(price > 0)) return null;
  return Number(price.toFixed(decimales(price)));
}

/**
 * Crea un calmador. Guarda qué número se está enseñando y decide si hay algo
 * nuevo que pintar.
 *
 * `siguiente(precio)` devuelve null cuando no hay que repintar —que es la
 * mayoría de las veces— y `{ valor, direccion, decimales }` cuando sí.
 */
function crear({ objetivo = OBJETIVO, banda = BANDA, minMs = MIN_MS } = {}) {
  let mostrado = null;   // el número que está en pantalla, ya cuantizado
  let pintadoEn = 0;

  return {
    siguiente(precio, now = Date.now()) {
      if (!(precio > 0)) return null;

      // El primero entra sin esperar: la pantalla no puede quedarse vacía
      // un cuarto de segundo por una regla pensada para el ruido.
      if (mostrado === null) {
        mostrado = cuantizar(precio);
        pintadoEn = now;
        return { valor: mostrado, direccion: null, decimales: decimales(mostrado) };
      }

      // Histéresis: se mide contra lo que se está ENSEÑANDO, no contra una
      // rejilla fija. Un precio que oscila dentro de la banda no repinta
      // nunca, caiga donde caiga respecto al redondeo.
      //
      // La banda nunca es menor que el escalón: si lo fuera, el número podría
      // "moverse" sin que cambiara ningún dígito visible, y eso es un
      // destello de color sin motivo.
      // Nunca menos de un dígito visible: por debajo de eso el número no
      // podría cambiar aunque se repintara, y sería un destello sin motivo.
      const umbral = Math.max(mostrado * banda, 10 ** -decimales(mostrado));
      if (Math.abs(precio - mostrado) < umbral) return null;
      if (now - pintadoEn < minMs) return null;

      const q = cuantizar(precio);
      if (q === mostrado) return null;

      const direccion = q > mostrado ? 'sube' : 'baja';
      mostrado = q;
      pintadoEn = now;
      return { valor: q, direccion, decimales: decimales(q) };
    },

    // Al cambiar de activo hay que olvidar: si no, el primer precio del nuevo
    // se compararía con el del anterior y saldría un destello sin sentido.
    reiniciar() {
      mostrado = null;
      pintadoEn = 0;
    },

    get valor() {
      return mostrado;
    },
  };
}

const API = { crear, cuantizar, escalon, exponente, decimales, OBJETIVO, BANDA, MIN_MS };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else globalThis.PrecioVivo = API;
})();
