# Prueba principal a mitad del bloque

BTC 15m, versión kalshi-midpoint-450s-v2. Primera captura disponible a 450 ±30 segundos del cierre, tanto en inicio de consulta como en captura final. El primer pronóstico o abstención por contrato queda congelado; no se escoge después el más acertado.

La versión v2 normaliza únicamente los dos instantes fechados en el texto de las reglas para agrupar contratos equivalentes. Conserva el texto de fuente, promedio, redondeo, comparación y reglas secundarias. La versión v1 separaba cada contrato por fecha/hora y no pudo entrenar. Los registros antiguos se conservan; no se convierten en pronósticos v2 retrospectivos. Proveedores y versiones neuronales continúan separados.

Reutiliza sólo capturas históricas de esa ventana, con observaciones y predicciones conocidas antes de consultar: BRTI/meta, TimesFM/meta, consolidado/meta, movimiento, rango, diferencia consolidado/BRTI y tiempo restante. Se separan fuente, proveedores, versión neuronal, operador y hash de reglas. No convierte observaciones del último minuto en predicciones de mitad de bloque.

Al menos 60 contratos de ajuste y 20 posteriores de calibración; todas las etiquetas del ajuste deben estar disponibles antes de la primera calibración. Todas las etiquetas deben ser oficiales y conocidas antes de emitir. Máximo 500 contratos históricos. Entrenar con el histórico no suma aciertos: evaluación exclusivamente de nuevos pronósticos congelados.

Regla económica midpoint-margin-v1: un contrato teórico, profundidad real para comprar al ask, libro de antigüedad máxima 3 segundos, tarifas verificadas recientes, margen mínimo 0,03 USD después de cota de comisiones y reserva operativa de 0,01 USD. Mantener hasta liquidación oficial. No envía órdenes y no modifica capital/riesgo del bot. Precios observados no son fills; falta validar ejecución antes de atribuir beneficio realizable.

Panel al inicio de Progreso IA, GET /api/learning pilot.midpoint. Evidencia y artefactos en datos/piloto-btc15m. Las demás pruebas conservan su horizonte y versiones. 17 pruebas relevantes aprobadas incluyendo aislamiento temporal, congelación, embargo, deduplicación y costes.
