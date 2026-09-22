'use strict';

(function () {

// Tarjetas que se arrastran y se quedan donde las dejas.
//
// Se usan eventos de PUNTERO y no la API de arrastrar y soltar de HTML5.
// Aquélla es la obvia y no funciona con el dedo: en un móvil o una tableta el
// `dragstart` no llega nunca. Los eventos de puntero unifican ratón, dedo y
// lápiz con el mismo código, así que esto funciona en todas partes en vez de
// en el escritorio y punto.
//
// El asa es un elemento aparte, no la tarjeta entera. Dentro de las tarjetas
// hay casillas, desplegables y selectores: si toda la tarjeta arrastrase,
// marcar "avisar antes de romper" se convertiría en una apuesta.
//
// Y el orden se guarda por página. La de cripto y la de acciones tienen
// tarjetas distintas y a nadie le sirve el orden de la otra.

const ASA = '⠿'; // seis puntos: el símbolo de "esto se arrastra"

function leerOrden(clave) {
  try {
    const guardado = JSON.parse(localStorage.getItem(clave) || 'null');
    return Array.isArray(guardado) ? guardado : null;
  } catch {
    return null; // en modo privado localStorage lanza; se sigue sin recordar
  }
}

function guardarOrden(clave, ids) {
  try {
    localStorage.setItem(clave, JSON.stringify(ids));
  } catch {
    /* idem */
  }
}

function tarjetasDe(contenedor) {
  return [...contenedor.querySelectorAll(':scope > [data-tarjeta]')];
}

function ordenActual(contenedor) {
  return tarjetasDe(contenedor).map((t) => t.dataset.tarjeta);
}

// Aplica un orden guardado. Las que no estén en la lista —porque se añadió una
// tarjeta nueva después de guardar el orden— van al final, conservando entre
// ellas el orden del marcado. Al final y visibles: hacerlas desaparecer porque
// una versión anterior no las conocía sería mucho peor que un orden imperfecto.
function aplicarOrden(contenedor, ids) {
  if (!ids) return;
  const porId = new Map(tarjetasDe(contenedor).map((t) => [t.dataset.tarjeta, t]));
  for (const id of ids) {
    const t = porId.get(id);
    if (t) contenedor.appendChild(t);
  }
  for (const [id, t] of porId) if (!ids.includes(id)) contenedor.appendChild(t);
}

/**
 * Hace arrastrables las tarjetas de un contenedor.
 *
 * @param contenedor  el elemento que las contiene
 * @param clave       dónde se guarda el orden
 */
function activar({ contenedor, clave, etiqueta = 'Mover tarjeta' }) {
  if (!contenedor) return null;

  aplicarOrden(contenedor, leerOrden(clave));

  const tarjetas = tarjetasDe(contenedor);
  for (const t of tarjetas) ponerAsa(t, etiqueta);

  let arrastrando = null;
  let hueco = null;
  let desfaseY = 0;

  function empezar(e, tarjeta) {
    // Sólo el botón principal: con el derecho se abre el menú del sistema y
    // la tarjeta se quedaría pegada al cursor.
    if (e.button !== undefined && e.button !== 0) return;

    const caja = tarjeta.getBoundingClientRect();
    desfaseY = e.clientY - caja.top;

    // El hueco conserva el sitio: sin él, sacar la tarjeta del flujo encoge la
    // columna y todo lo de abajo da un salto.
    hueco = document.createElement('div');
    hueco.className = 'tarjeta-hueco';
    hueco.style.height = `${caja.height}px`;
    tarjeta.parentNode.insertBefore(hueco, tarjeta);

    tarjeta.classList.add('arrastrando');
    tarjeta.style.width = `${caja.width}px`;
    tarjeta.style.top = `${caja.top}px`;
    tarjeta.style.left = `${caja.left}px`;

    arrastrando = tarjeta;
    e.target.setPointerCapture?.(e.pointerId);
  }

  function mover(e) {
    if (!arrastrando) return;
    e.preventDefault();

    arrastrando.style.top = `${e.clientY - desfaseY}px`;

    // Dónde cae: se compara con el centro de cada tarjeta, que es lo que hace
    // que el intercambio se sienta natural en vez de esperar a solaparlas.
    const otras = tarjetasDe(contenedor).filter((t) => t !== arrastrando);
    let destino = null;
    for (const t of otras) {
      const c = t.getBoundingClientRect();
      if (e.clientY < c.top + c.height / 2) {
        destino = t;
        break;
      }
    }

    if (destino) contenedor.insertBefore(hueco, destino);
    else contenedor.appendChild(hueco);
  }

  function soltar() {
    if (!arrastrando) return;

    contenedor.insertBefore(arrastrando, hueco);
    hueco.remove();
    hueco = null;

    arrastrando.classList.remove('arrastrando');
    arrastrando.style.width = '';
    arrastrando.style.top = '';
    arrastrando.style.left = '';
    arrastrando = null;

    guardarOrden(clave, ordenActual(contenedor));
  }

  for (const tarjeta of tarjetas) {
    const asa = tarjeta.querySelector('.tarjeta-asa');
    if (!asa) continue;

    asa.addEventListener('pointerdown', (e) => empezar(e, tarjeta));

    // Con teclado: las flechas mueven la tarjeta enfocada. Arrastrar es de
    // ratón y de dedo; sin esto, quien navegue con el teclado no podría
    // reordenar nada.
    asa.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();

      const lista = tarjetasDe(contenedor);
      const i = lista.indexOf(tarjeta);
      const j = e.key === 'ArrowUp' ? i - 1 : i + 1;
      if (j < 0 || j >= lista.length) return;

      if (e.key === 'ArrowUp') contenedor.insertBefore(tarjeta, lista[j]);
      else contenedor.insertBefore(lista[j], tarjeta);

      guardarOrden(clave, ordenActual(contenedor));
      asa.focus();
    });
  }

  window.addEventListener('pointermove', mover, { passive: false });
  window.addEventListener('pointerup', soltar);
  window.addEventListener('pointercancel', soltar);

  return {
    orden: () => ordenActual(contenedor),
    reiniciar() {
      try {
        localStorage.removeItem(clave);
      } catch {
        /* idem */
      }
      location.reload();
    },
  };
}

function ponerAsa(tarjeta, etiqueta) {
  if (tarjeta.querySelector('.tarjeta-asa')) return;

  const titulo = tarjeta.querySelector('h2') || tarjeta.firstElementChild;
  if (!titulo) return;

  const asa = document.createElement('button');
  asa.type = 'button';
  asa.className = 'tarjeta-asa';
  asa.textContent = ASA;
  asa.title = `${etiqueta} (arrastra, o flechas ↑↓)`;
  asa.setAttribute('aria-label', asa.title);
  titulo.insertBefore(asa, titulo.firstChild);
}

const API = { activar, aplicarOrden, ordenActual, leerOrden, guardarOrden, ASA };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else globalThis.Tarjetas = API;
})();
