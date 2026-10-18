# Investigación de rentabilidad · 26 septiembre 2026

Conclusión: existe una hipótesis comprobable, no una ventaja acreditada. Priorizar un modelo de probabilidad de liquidación BTC15m con selección por precio y coste; conservar TimesFM como una variable candidata. No aumentar capital ni activar ejecución con la muestra actual.

## Evidencia local

Captura congelada: datos/diagnosticos/research-1790460880003/report.json y events-snapshot.jsonl. 261 observaciones, 20 contratos distintos, 19 resultados oficiales, 18 observaciones elegibles por ventana. Comparación exploratoria sobre los mismos 17 contratos resueltos con fuente consolidada USD y proveedores binance/coinbase/gemini/kraken, versión f4e7ee5ac7b6ad00. Una observación por contrato, primera disponible en 10 minutos restantes ±30 segundos. Los cientos de snapshots no son cientos de resultados independientes.

Regla examinada retrospectivamente: comprar un contrato del lado indicado por comparar la estimación puntual con el umbral; mantener a liquidación. El precio es el ask anunciado en el snapshot. Es un escenario optimista sin ejecución acreditada, no una operación realizada ni un backtest operativo. La regla se eligió tras inspeccionar los datos; no es validación prospectiva independiente.

| Referencia | Aciertos / 17 | Bruto hipotético USD | Tras comisión ilustrativa USD | Más 1 centavo adverso por caso USD |
|---|---:|---:|---:|---:|
| Neuronal | 11 | 0,68 | 0,36 | 0,19 |
| Candidato corregido | 11 | 0,68 | 0,36 | 0,19 |
| Último precio | 11 | -0,84 | -1,16 | -1,33 |
| Lado favorito del mercado | 12 | -0,01 | -0,33 | -0,50 |

Comisión ilustrativa: 0,07 × p × (1−p), un contrato, redondeada hacia arriba al céntimo. NO valida overrides de evento, precisión de cuenta, rebates ni tarifas históricas. El escenario de un centavo es una sensibilidad fija, no slippage medido. Excluye costes de IA, ordenador e impuestos. No extrapolar 0,36 USD a rendimiento diario: son sólo 17 casos correlacionados. Cambiar un único resultado puede alterar la conclusión.

Ejecutable de investigación: node scripts/research-btc15m.js. Guarda snapshot exacto con SHA-256 y todos los casos por ticker, versión, lado, coste y resultado para revisión.

## Prioridades propuestas

1. **Medir el objetivo correcto.** Recolectar BRTI por segundo y reconstruir la ventana de 60 segundos fijada por las reglas; comprobarla con expiration_value oficial. Conservar segundos ausentes sin rellenarlos. El cierre consolidado puntual sirve como señal, no como etiqueta oficial.
2. **Estimar probabilidad calibrada.** Modelo local sencillo primero: distancia índice-umbral normalizada por volatilidad, segundos restantes, retorno reciente y volatilidad; comparar una versión con TimesFM añadido. Entrenar con contratos anteriores liquidados, calibrar en otro segmento temporal y evaluar en contratos futuros congelados. Evitar introducir el resultado o datos posteriores en variables.
3. **Comprar sólo ventaja neta.** Por contrato mantenido a liquidación: EV = probabilidad estimada del lado − ask ejecutable − comisión − costes esperados. La condición de entrada debe exigir un margen que sobreviva a incertidumbre de calibración y ejecución. No utilizar el porcentaje de aciertos como criterio suficiente. No hay todavía probabilidad calibrada ni umbral de entrada aprobado.
4. **Medir ejecución antes de optimizarla.** Índice y libro por WebSocket con fechas de fuente/recepción, secuencias, reconexión, snapshots y rechazo de huecos. Validar tarifas de serie/evento y redondeos de cuenta. Mantener una simulación conservadora de profundidad/latencia. Una actualización cada minuto no permite medir oportunidades de segundos.
5. **Reducir coste fijo.** Mantener cálculo numérico local; medir coste de llamadas del agente y usarlo para revisión de reglas/incidencias, no como predictor por tick. Con capital 20 USD, un coste de 1 USD consume el 5% del capital: ejemplo aritmético, no coste actual medido.

## Alternativas evaluadas

| Vía | Prioridad | Justificación y límite |
|---|---|---|
| Probabilidad de liquidación BTC15m + filtro económico | Primera | Aprovecha datos y piloto existentes; aún sin ventaja probada. |
| Órdenes pasivas / maker | Investigación posterior | Puede cambiar costes, pero faltan cola, tasa de ejecución, inventario y selección adversa. No asumir fill cuando el precio toca la orden. |
| Arbitraje Kalshi–Polymarket US | Secundaria | Falta demostrar contratos equivalentes, tarifas y cobertura de ambas patas; títulos parecidos no bastan. El último snapshot del escáner tenía cero coincidencias cruzadas y cero oportunidades proyectadas, con cobertura parcial. |
| Retraso exchange–Kalshi | Hipótesis a medir | Correlación o retraso visual no demuestra un precio ejecutable favorable. Requiere datos sincronizados y prueba fuera de muestra. |
| Programa institucional de liquidez | No basar el piloto en él | Kalshi exige acuerdo y designación para ese programa; no es ingreso automático por mantener órdenes. |

## Hallazgos externos relevantes

- Kalshi confirma promedio de 60 observaciones RTI al vencimiento: [Crypto Markets](https://help.kalshi.com/en/articles/13823838-crypto-markets).
- La API de la serie KXBTC15M devolvió fee_type=quadratic y fee_multiplier=1 en esta revisión; eso no resuelve por sí solo tarifas de evento o cuenta: [Get Series](https://docs.kalshi.com/api-reference/market/get-series).
- El PDF obtenido directamente tiene fecha efectiva 7 julio 2026; resultados de búsqueda mostraban copias anteriores. Usar fuentes directas y guardar versión, no snippets: [Tarifario Kalshi](https://kalshi.com/docs/kalshi-fee-schedule.pdf).
- La documentación de redondeo distingue cuentas directas y no directas, acumulador por orden y rebates. La aproximación al céntimo del proyecto no es conciliación contable exacta: [Fee Rounding](https://docs.kalshi.com/getting_started/fee_rounding).
- Índice y libro están disponibles por conexiones autenticadas: [CF Benchmarks](https://docs.kalshi.com/websockets/cfbenchmarks-value), [Orderbook Updates](https://docs.kalshi.com/websockets/orderbook-updates). Su disponibilidad técnica no acredita acceso concreto ni ventaja de velocidad.
- Polymarket US publicó una tarifa efectiva 25 septiembre 2026: coeficiente taker estándar 0,0695 y rebate maker -0,0125, con excepciones. Revisar adaptador y metadatos antes de calcular arbitraje; no asumir antiguas comisiones: [Fee Schedule](https://docs.polymarket.us/fees).
- Los incentivos institucionales Kalshi requieren condiciones y acuerdo: [Liquidity Provider Program](https://help.kalshi.com/en/articles/15410219-liquidity-provider-program).

## Criterio de continuación

Completar instrumentación y costes; después congelar modelo y regla económica e iniciar la evaluación independiente del protocolo PILOTO-BTC15M.md. Como mínimo de revisión propuesto, 200 contratos durante 14 días, nunca como permiso automático para operar. Examinar incertidumbre por día y costes adversos; si no hay mejora neta robusta sobre no operar, descartar esa versión. No prometer rentabilidad ni protección absoluta del capital.

En esta investigación no se modificaron modelo activo, credenciales, capital, límites ni ejecución real.
