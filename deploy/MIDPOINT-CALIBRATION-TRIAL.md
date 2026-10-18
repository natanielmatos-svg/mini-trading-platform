# Comparación prospectiva de calibración

Versión: midpoint-calibration-trial-v1. Fecha: 2026-10-07.

Diagnóstico retrospectivo reproducible: `node scripts/diagnose-midpoint-calibration.js`. En 37 contratos: Brier bruto 0.2049543, calibrado 0.2378049; mercado 0.2037896. Esto sugiere revisar la calibración, no demuestra ventaja económica ni constituye validación nueva.

Desde el despliegue se congelan, en la captura existente BTC 15m a 7:30 ±30 s, la salida logística original, su calibración actual y el punto medio del libro fresco. Se conserva el identificador del mismo artefacto de entrenamiento. No se reconstruyen predicciones antiguas para esta prueba. Las familias de reglas, fuentes y versiones siguen separadas.

La evaluación requiere los tres valores válidos y el resultado oficial. Se deduplica por contrato. Cada alternativa usa la política económica vigente, tarifas verificadas y reserva existentes. Los resultados son teóricos, sin fills, sin órdenes y sin promoción automática. El mercado es referencia probabilística, no estrategia ejecutada. Los aciertos BRTI continúan en la comparación principal.

Visible en Progreso de la IA → Calibración · comparación nueva. No se reanuda la automatización pausada.

Pruebas: midpoint-calibration-trial, kalshi-midpoint, kalshi-hybrid y btc15m-capture: 17 aprobadas.
