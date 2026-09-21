#!/usr/bin/env node
'use strict';

// Arranca el servidor en modo demo.
//
// Existe por Windows: `DEMO=1 node server.js` es sintaxis de shells POSIX y en
// PowerShell o cmd falla con "DEMO=1 no se reconoce como un comando". Fijar la
// variable aquí funciona en los tres sin añadir una dependencia (cross-env
// sería un paquete entero para una línea).

process.env.DEMO = '1';

const app = require('../server.js');

// server.js sólo escucha cuando se ejecuta directamente, así que aquí hay que
// pedírselo.
app.start();
