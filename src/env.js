'use strict';

// Carga un archivo .env si existe, antes que nada.
//
// Existe por una razón concreta: las claves se configuran con variables de
// entorno, y la sintaxis para eso es distinta en cada shell —`export X=...`
// en bash, `$env:X = "..."` en PowerShell, `set X=...` en cmd—, se pierden al
// cerrar la ventana y es facilísimo acabar depurando el shell en vez de la
// aplicación. Con un .env se escribe una vez y funciona en los tres.
//
// Sin dependencias: Node sabe leerlo desde la 20.12. En una anterior se avisa
// en vez de fallar, porque las variables exportadas a mano siguen valiendo.
//
// Lo que ya esté en el entorno MANDA sobre el archivo: así una variable
// puesta para un arranque concreto no se la come el .env.

const fs = require('fs');
const path = require('path');

const RUTA = path.join(__dirname, '..', '.env');

function cargar() {
  if (!fs.existsSync(RUTA)) return { cargado: false, motivo: 'no hay .env' };

  if (typeof process.loadEnvFile !== 'function') {
    return { cargado: false, motivo: `hay un .env pero Node ${process.versions.node} no sabe leerlo (hace falta 20.12 o superior)` };
  }

  // Qué había ya puesto a mano, para no pisarlo.
  const previas = new Set(Object.keys(process.env));
  const antes = { ...process.env };

  try {
    process.loadEnvFile(RUTA);
  } catch (err) {
    return { cargado: false, motivo: `el .env no se pudo leer: ${err.message}` };
  }

  for (const clave of previas) process.env[clave] = antes[clave];
  return { cargado: true, motivo: null };
}

const resultado = cargar();

module.exports = { ...resultado, RUTA };
