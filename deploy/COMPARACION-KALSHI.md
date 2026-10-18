# Comparación prospectiva BTC15m

Versión kalshi-point-transfer-v1, incorporada el 28/09/2026. El recolector existente guarda modelBenchmark en nuevas capturas elegibles, 10 minutos ±30 segundos antes del cierre. No se crean procesos adicionales ni se rellenan pronósticos retrospectivos.

Cuatro estimaciones en USD: TimesFM (última predicción de vela disponible desde la apertura), IA local (última emisión de menos de 90 segundos), precio consolidado y BRTI instantáneo (observaciones de menos de 90 segundos). Se guardan tiempos de emisión y versión/modelId. La antigüedad desigual de TimesFM es parte de esta prueba de uso; no atribuir diferencias exclusivamente a arquitectura.

Se evalúan los mismos contratos por grupo de fuente/proveedores/versión/cuarto local/operador; una captura por contrato y grupo. MAE en USD sólo cuando expiration_value es numérico positivo y concuerda con el resultado oficial según umbral y operador. El acierto binario usa exclusivamente resultados finalized/settled. No convertir acierto de lado en probabilidad calibrada. Los grupos no se suman como contratos independientes.

Es una prueba de transferencia: TimesFM e IA local siguen entrenados para cierres de velas consolidadas, no para el promedio oficial BRTI. Las reglas completas y su hash se conservan por captura; contratos fechados distintos no crean un grupo por fecha. No afirmar equivalencia de objetivos. El candidato logístico de liquidación ya existente sigue separado con su evaluación Brier.

API: GET /api/learning → pilot.modelBenchmark. Interfaz: Progreso de la IA → Comparación con liquidación oficial. No hay promoción ni cambio de riesgo/órdenes. Cero resultados iniciales es correcto: esperar nuevos pronósticos congelados y resultados oficiales. Antes de cualquier decisión estudiar intervalos de incertidumbre por bloques/días, cambios de régimen, calidad de fuentes y costes de ejecución. Más de 100 contratos por sí solo no certifica ventaja.

Pruebas: node --test test/kalshi-model-benchmark.test.js test/btc15m-capture.test.js test/settlement-probability.test.js
