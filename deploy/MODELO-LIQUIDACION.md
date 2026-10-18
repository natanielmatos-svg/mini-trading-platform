# Candidato de probabilidad BTC15m

Implementado en src/settlement-probability.js e integrado en el recolector existente. No cambia TimesFM ni envía órdenes. Predice el resultado oficial YES/NO; no intenta presentar un cierre puntual como liquidación.

Regresión logística regularizada con dos variables: distancia porcentual BRTI-umbral y distancia TimesFM-umbral. Sólo ventana fija de 10 minutos restantes ±30 segundos, BRTI anterior a la solicitud con máximo 90 segundos de edad, fuente consolidada USD y composición binance/coinbase/gemini/kraken. No se afirma simultaneidad entre índice, modelo y libro. La definición se separa por grupo, versión neuronal y operador del contrato.

Mínimo 80 contratos distintos con etiquetas oficiales ya conocidas: 60 para ajuste y 20 posteriores para calibración logística (Platt). Máximo 500. Exige al menos cinco resultados de cada clase en ambos segmentos; etiquetas de ajuste conocidas antes del inicio de calibración. El conjunto de calibración no es un resultado fuera de muestra. Se conservaron penalizaciones y optimizador fijos, sin optimizarlos sobre los resultados locales.

Emite a lo sumo una predicción congelada por contrato en la ventana. Guarda artefacto con entrenamiento, calibración, escalas, pesos y hash en datos/piloto-btc15m/models. La predicción se registra en events.jsonl; después de liquidar se compara Brier con el punto medio Kalshi del mismo snapshot. Sólo esos pronósticos futuros entran en las métricas, sin rellenar el histórico. El modelo se reajusta con etiquetas anteriores bajo una regla fija; sigue siendo candidato, no modelo activo.

Filtro económico exploratorio de un contrato: probabilidad del lado menos ask derivado del mejor bid opuesto, comisión ilustrativa 0,07*p*(1-p) al céntimo, reserva de deslizamiento 0,01 USD y reserva operativa 0,01 USD. Margen mínimo ilustrativo 0,03 USD. Requiere profundidad para una unidad y libro reciente. Las reservas NO son costes medidos ni límites monetarios del bot. No se modifica la configuración de riesgo.

Incluso superando ese margen permanece bloqueado: faltan tarifas/costes verificados y validación prospectiva independiente. La calibración con 20 contratos es experimental; no es un intervalo de confianza ni una ventaja demostrada. No activa trading tras alcanzar 80 ni al superar un número de aciertos.

Visualización: Progreso IA → Probabilidad de liquidación. API: /api/learning → pilot.probability. Recopilar los contratos suficientes requiere servidor encendido y ventanas válidas; no se promete una fecha. Sigue pendiente mejorar frecuencia/sincronización del índice y libro y verificar costes exactos según RUTA-RENTABILIDAD.md.
