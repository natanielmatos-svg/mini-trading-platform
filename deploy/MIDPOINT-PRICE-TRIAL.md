# Prueba prospectiva de precio — 2026-10-08

Versión midpoint-price-band-v1. Hipótesis exploratoria surgida del diagnóstico de 85 contratos; ninguno de esos resultados cuenta como validación de esta prueba.

BTC 15m, captura existente a 7:30 ±30 segundos, modelo calibrado vigente. Se conserva la elección original del lado y el margen mínimo existente; después se exige precio de entrada >=0,25 y <0,50 USD. No se busca otro lado cuando el elegido queda fuera. Un contrato teórico, profundidad y tarifas verificadas por la política existente, salida a liquidación oficial. No se modifican modelos, límites ni ejecutores.

Se guarda la decisión antes del resultado en midpointPriceTrial junto al modelo, familia de reglas y probabilidad del mercado. Se evalúan exclusivamente registros nuevos con este campo. La precisión probabilística del modelo y del mercado se compara sobre las mismas entradas seleccionadas. El mercado con la misma política de costes puede abstenerse: no se interpreta abstención como beneficio ni se fuerza a operar.

Se reportan entradas, abstenciones, pendientes, ganadoras, probabilidad media, Brier emparejado, neto teórico, caída máxima y estrés de 0,02 USD adicionales por entrada. Las comisiones son cotas, no tarifas ejecutadas. Los precios observados no garantizan fills.

Primera revisión: >=100 entradas liquidadas en >=7 fechas UTC distintas con entradas por grupo. Es un punto de revisión manual, no prueba de significancia ni autorización de producción. No hay órdenes reales/demo, promociones automáticas ni reactivación del agente programado.

Visible en Progreso de la IA, «Prueba nueva · entradas de 0,25 a menos de 0,50 USD». Pruebas de frontera, deduplicación, ausencia de relleno histórico, resultado, estrés e integración: 7 aprobadas.
