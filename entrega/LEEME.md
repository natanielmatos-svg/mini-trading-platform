# Entrega pendiente de aplicar

Cuatro parches que no se pueden aplicar en esta rama todavía porque los
módulos que tocan viven solo en el árbol local, sin empujar. Se guardan aquí
para que no dependan de una carpeta temporal.

Todos se midieron contra la copia del árbol local del 5 y 18 de octubre.
Cuentas reales, no estimadas:

| parche | qué hace | módulo que necesita | pruebas |
|---|---|---|---|
| `escalera-de-strikes.patch` | el piloto abortaba cuando Kalshi publica más de un strike para el mismo cierre; ahora elige el más cercano al precio de referencia y se abstiene si hay empate | `src/btc15m-capture.js` | 12 |
| `brti-en-el-ranking.patch` | añade `brti` a los modelos ordenados del selector | `src/kalshi-demo-model-selector.js` | 9 |
| `pruebas-kalshi-book.patch` | la identidad de cruce yes/no (`yesAsk = 1 − noBid`), las cantidades del lado opuesto, y la coherencia con `kalshi-edge.incoherenteEn` | `src/kalshi-book.js` | 12 |
| `pruebas-kalshi-order-transport.patch` | la firma RSA-PSS verificada con `crypto.verify` sobre `timestamp+method+pathname`, que hagan falta `allowWrites` **y** `role==='bot'`, `redirect:'error'`, y que no se filtre el cuerpo del proveedor | `src/kalshi-order-transport.js` | 19 |

Total: 52 pruebas, 0 fallos.

## Cómo aplicarlos

Los dos de pruebas son archivos nuevos y entran limpios:

    git apply entrega/pruebas-kalshi-book.patch
    git apply entrega/pruebas-kalshi-order-transport.patch

Los dos que modifican `src/` se hicieron contra la copia de octubre. Si esos
archivos han cambiado desde entonces, el parche recto falla y hay que dejar
que git haga la fusión a tres bandas:

    git apply -3 entrega/escalera-de-strikes.patch
    git apply -3 entrega/brti-en-el-ranking.patch

Después, siempre:

    npm test

## Por qué el piloto estaba parado

En `src/btc15m-capture.js` la selección era:

    if (chosen.contracts.length !== 1) { ... return; }

Es decir: se abstenía de capturar en cuanto Kalshi publicaba una escalera de
strikes para el mismo cierre, que es lo normal. Por eso el piloto llevaba
semanas en 17 contratos. `escalera-de-strikes.patch` sustituye eso por
`elegirUmbral()`, que toma el strike más cercano al último precio de
referencia de BTCUSDT a 15m del mismo cierre, y se abstiene solo si hay
empate exacto entre dos strikes — ahí no hay criterio y abstenerse es lo
correcto.
