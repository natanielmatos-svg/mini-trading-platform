# Variables observacionales de Kalshi

6 de octubre de 2026. Versión kalshi-market-features-v1.

El piloto BTC 15m conserva, en la primera evaluación BRTI a diez minutos del cierre, el movimiento observado de 5, 15 y 60 segundos, la distancia al umbral, el tiempo restante, el hash de las reglas y las fechas de referencia/libro junto con la evidencia de tarifas. Se utiliza la respuesta de índice que ya se solicita; no hay procesos ni consultas adicionales.

Los movimientos requieren cobertura en los extremos y huecos máximos de 1,5 segundos. Se deduplican fechas; los precios contradictorios invalidan la cobertura. No se usan muestras posteriores al corte. Una ventana insuficiente conserva null, nunca un movimiento inventado. Estos datos no son el promedio de liquidación.

El estado de recolección está en pilot.featureCollection dentro de GET /api/learning. La evidencia se conserva en datos/piloto-btc15m/events.jsonl y sobrevive reinicios. No se completa retrospectivamente el histórico.

El candidato separado kalshi-brti-motion-logistic-v1 se ajusta automáticamente cuando hay al menos 60 contratos de ajuste y 20 posteriores de calibración con ambos resultados y etiquetas conocidas antes de cada periodo. Incluye distancia/tiempo, movimientos BRTI 5/15/60s, rango, precios ejecutables del libro, spread y desequilibrio de cantidades de tres niveles. Separa reglas y operador, deduplica contratos y exige libro reciente y ventanas completas. Conserva cada artefacto y predicción antes del resultado. No promueve modelos.

GET /api/learning expone pilot.motionCandidate, también visible en Progreso de la IA. Puntúa exclusivamente predicciones futuras guardadas y compara Brier con la probabilidad media del mismo libro sobre los mismos casos y grupos. Calibración no es evaluación. No emite órdenes ni atribuye beneficio a la tasa de acierto: evaluación económica ejecutada sigue pendiente. Ninguna mejora de precisión o rentabilidad está demostrada por esta incorporación.

Verificación: 13 pruebas de movimiento, referencia, captura y replay. No se enviaron órdenes ni se modificaron límites o automatizaciones.
