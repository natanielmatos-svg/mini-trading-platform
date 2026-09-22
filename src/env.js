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
const os = require('os');
const path = require('path');

const RUTA = path.join(__dirname, '..', '.env');

// En Windows es de lo más normal acabar con un .env que no es UTF-8 a secas:
// el Bloc de notas guarda UTF-8 con BOM y `>` de PowerShell escribe UTF-16.
// Node no lo tiene en cuenta, y el resultado es el peor fallo posible: la
// primera variable se registra con el BOM pegado al nombre —"\uFEFFALPACA_KEY_ID"—
// así que process.env.ALPACA_KEY_ID queda sin definir y la aplicación dice
// que falta una clave que está escrita ahí mismo. Esto lo normaliza.
function decodificar(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { texto: bytes.slice(2).toString('utf16le'), arreglado: 'UTF-16LE' };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    // UTF-16BE: se le da la vuelta a cada par y se lee como LE.
    const volteado = Buffer.from(bytes.slice(2));
    volteado.swap16();
    return { texto: volteado.toString('utf16le'), arreglado: 'UTF-16BE' };
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { texto: bytes.slice(3).toString('utf8'), arreglado: 'UTF-8 con BOM' };
  }
  // UTF-16 sin BOM: en un .env, que es ASCII, sale un byte cero de cada dos.
  const cabeza = bytes.slice(0, 64);
  if (cabeza.includes(0)) {
    const impares = cabeza.filter((b, i) => i % 2 === 1 && b === 0).length;
    if (impares > cabeza.length / 4) return { texto: bytes.toString('utf16le'), arreglado: 'UTF-16LE sin BOM' };
  }
  return { texto: bytes.toString('utf8'), arreglado: null };
}

function cargar() {
  if (!fs.existsSync(RUTA)) return { cargado: false, motivo: 'no hay .env' };

  if (typeof process.loadEnvFile !== 'function') {
    return { cargado: false, motivo: `hay un .env pero Node ${process.versions.node} no sabe leerlo (hace falta 20.12 o superior)` };
  }

  // Qué había ya puesto a mano, para no pisarlo.
  const previas = new Set(Object.keys(process.env));
  const antes = { ...process.env };

  let arreglado = null;
  let temporal = null;

  try {
    const { texto, arreglado: codificacion } = decodificar(fs.readFileSync(RUTA));
    arreglado = codificacion;

    // El archivo normal se lee tal cual; sólo se hace una copia cuando hay
    // algo que normalizar, y se usa el lector de Node en los dos casos para
    // no acabar manteniendo un segundo parser con otras reglas de comillas.
    let destino = RUTA;
    if (arreglado) {
      temporal = path.join(os.tmpdir(), `env-${process.pid}-${Date.now()}`);
      fs.writeFileSync(temporal, texto, 'utf8');
      destino = temporal;
    }

    process.loadEnvFile(destino);
  } catch (err) {
    return { cargado: false, motivo: `el .env no se pudo leer: ${err.message}`, arreglado };
  } finally {
    if (temporal) fs.rmSync(temporal, { force: true });
  }

  for (const clave of previas) process.env[clave] = antes[clave];
  return { cargado: true, motivo: null, arreglado };
}

const resultado = cargar();

module.exports = { ...resultado, RUTA };
