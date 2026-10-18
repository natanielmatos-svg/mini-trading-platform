# Candidato híbrido Kalshi

Versión kalshi-hybrid-intrablock-v1. Sólo BTC 15m, ventana 10 minutos ±30 segundos antes del cierre. No opera ni sustituye modelos existentes.

Objetivo: resultado oficial YES/NO de Kalshi. Entradas: distancias porcentuales BRTI/meta, TimesFM/meta y consolidado/meta, movimiento y rango de observaciones intrabloque, diferencia consolidado/BRTI y minutos restantes. El rango es de precios observados, no OHLC final. Exige tres observaciones y al menos un minuto de cobertura, con fuentes recientes y fechas anteriores a la emisión.

Entrenamiento logístico regularizado y calibración temporal independiente (60 contratos de ajuste y 20 posteriores de calibración como mínimo, al menos cinco resultados de cada clase en ambos). Máximo 500 contratos comparables. Las etiquetas del ajuste deben ser conocidas antes de comenzar la calibración; todas las etiquetas deben ser conocidas antes del pronóstico actual. Separación por grupo, proveedores, versión TimesFM y operador de meta. Modelo y datos exactos de ajuste se guardan bajo datos/piloto-btc15m/models usando hash de contenido.

Los registros anteriores sin intrablock no se reconstruyen ni se cuentan como resultados futuros. Se guarda hybridProbability antes del cierre en events.jsonl; sólo estos pronósticos se evalúan, una vez por contrato, contra resultados oficiales definitivos. El panel Progreso IA muestra ajuste, calibración, aciertos, fallos, Brier y las referencias TimesFM/consolidado/BRTI sobre los mismos contratos. Los grupos de versiones se muestran separados. El Brier mide probabilidades, no beneficio.

Integrado en el recolector existente: sin procesos nuevos ni automatizaciones programadas adicionales. La recogida continúa mientras el servidor esté activo. Llegar a 80 contratos no acredita ventaja y la promoción automática está deshabilitada. No se modifican credenciales ni riesgo.
