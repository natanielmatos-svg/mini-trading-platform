#!/usr/bin/env node
'use strict';

// ¿Cuántos contratos hacen falta para saber si hay ventaja?
//
//   npm run potencia -- --aciertos 11 --casos 17
//   npm run potencia -- --aciertos 11 --casos 17 --precio 0.5
//
// Responde a la pregunta que va ANTES que «¿cuánto voy a ganar?», y que casi
// nunca se hace: si la muestra que tengo puede distinguir una estrategia
// ganadora de una perdedora. Mientras la respuesta sea que no, cualquier cifra
// de rentabilidad es ruido con formato de resultado.

const P = require('../src/potencia');
const { num } = require('../src/format');

function arg(nombre, pordefecto = null) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : pordefecto;
}

const aciertos = Number(arg('aciertos', 11));
const casos = Number(arg('casos', 17));
const precio = Number(arg('precio', 0.5));

const d = P.diagnostico({ aciertos, casos, precio });
if (!d.ok) {
  console.error(d.reason);
  process.exitCode = 1;
} else {
  const pct = (x) => `${num(x * 100, 1)}%`;

  console.log(`Muestra: ${aciertos} aciertos de ${casos}, comprando a ${num(precio * 100, 0)}¢\n`);
  console.log(`  acierto observado   ${pct(d.intervalo.observado)}`);
  console.log(`  intervalo 95%       ${pct(d.intervalo.bajo)} a ${pct(d.intervalo.alto)}`);
  console.log(`  equilibrio          ${pct(d.equilibrio.acierto)}  (${num(precio * 100, 0)}¢ + ${num(d.equilibrio.comision * 100, 0)}¢ de comisión)`);
  console.log('');
  console.log(`  ${d.concluyente ? '→' : '⚠'} ${d.veredicto}`);
  console.log('');

  if (d.supuestos.length) {
    console.log('Contratos necesarios para distinguir la ventaja del ruido (95%, potencia 80%):\n');
    console.log('    si el acierto real es   ventaja/contrato   contratos');
    for (const s of d.supuestos) {
      console.log(
        `    ${pct(s.acierto).padStart(21)}   ${(num(s.ventajaPorContrato, 3) + ' $').padStart(16)}   ${String(s.contratos).padStart(9)}` +
        (s.medido ? '   ← el medido' : ''),
      );
    }
    console.log('');
    console.log('No planifiques con la fila marcada. Esa tasa sale de una muestra corta y');
    console.log('suele elegirse DESPUÉS de mirar los datos, así que es la más optimista que');
    console.log('hay: da el tamaño de muestra más pequeño posible, que es justo el error.');
  }
}
