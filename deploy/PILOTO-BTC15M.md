# Piloto único: BTC / KXBTC15M

Estado: captura observacional integrada al recolector del servidor; evaluación financiera bloqueada por objetivo y costes sin validar. No cambia la configuración del bot horario ni activa órdenes.

## Captura implementada

src/btc15m-capture.js se ejecuta al terminar cada ronda del recolector existente, sin temporizador ni proceso adicionales. Guarda datos/piloto-btc15m/events.jsonl: contrato actual único KXBTC15M, umbral/operador, reglas con hash, cotizaciones en dólares y profundidad, fechas de solicitud/recepción y predicciones ya existentes ANTES de solicitar el mercado. Nunca añade después una predicción al snapshot pasado. Conserva fuente, moneda, proveedores y versión.

Reintenta hasta cuatro contratos vencidos por ronda, con espera de cinco minutos por contrato. Sólo acepta finalized/settled no provisional con ticker exacto. Guarda la etiqueta oficial por separado del cierre consolidado. Deduplica muestras por contrato/minuto y resultados por contrato al reiniciar. Una lista incompleta o ambigua, cruce del cierre o captura superior a 15 segundos se rechaza. Libro ausente se registra; no implica liquidez ni fill. La hora de origen de las cotizaciones no está disponible: quoteSourceAt=null.

La ventana fija de 10 minutos ±30 segundos etiqueta capturas, no operaciones evaluables. Faltan conversión neuronal al objetivo de liquidación, tarifas verificadas y estrategia congelada. Se muestra avance en «Progreso de la IA» y GET /api/learning, campo pilot. No es un backtest ni entrenamiento financiero independiente iniciado. Referencia de campos: https://docs.kalshi.com/api-reference/market/get-market.

## Primera entrega

`node scripts/audit-btc15m.js` genera una carpeta fechada en datos/diagnosticos con informe, métricas y copias exactas de las fuentes (SHA-256). Lectura local; sin claves, compras, red ni entrenamiento. El diagnóstico separa contratos horarios, cierres consolidados y resultados de Kalshi. Los datos existentes son exploratorios; no constituyen un conjunto de prueba independiente después de haberlos inspeccionado.

## Antes de comenzar la evaluación independiente

1. Verificar continuidad de la captura KXBTC15M implementada y suficientes ventanas observadas. Medir desfases entre fuentes; las consultas secuenciales no son simultáneas.
2. Registrar liquidación oficial por ticker y tarifa aplicable. Verificar la equivalencia entre el objetivo del modelo y el promedio oficial; si no existe, entrenar/evaluar una conversión separada antes de operar. Nunca tratar un precio puntual TimesFM como probabilidad de ganar.
3. Congelar un manifiesto con hash de modelo y código, fuente/unidad/proveedores, objetivo, conversión a probabilidad, regla de entrada/salida y costes. Emitir una sola decisión por contrato en una ventana fija (por ejemplo, 10 minutos restantes, tolerancia ±30 segundos). Si falta la ventana, registrar omisión sin reconstrucción posterior.
4. Congelar antes de ver resultados: comparar neuronal, referencia sencilla y probabilidad de Kalshi exactamente sobre los mismos contratos e instantes. Las referencias son competidores, no tres muestras independientes.

## Protocolo de evaluación v1 propuesto

La muestra comienza únicamente tras completar y fechar el manifiesto anterior. Reunir al menos 200 contratos distintos durante un mínimo de 14 días; es un mínimo de revisión, no garantía estadística ni autorización automática. No ajustar parámetros con ese conjunto. Un cambio de estrategia exige otra muestra futura.

Simulación al ask disponible del lado comprado, con profundidad suficiente y latencia registrada; no asumir fills al punto medio. Si falta evidencia de ejecución, marcar no evaluable. Calcular resultado a liquidación menos coste de compra, comisiones verificadas y costes operativos asignados. Separar pérdidas realizadas, exposición pendiente y drawdown. No representar ausencias como cero.

Revisar beneficio neto, pérdidas, estabilidad por día y cobertura de casos. Estimar incertidumbre agrupando por día (los contratos cercanos están correlacionados); exigir que la mejora neta no dependa de un solo día o de supuestos optimistas de ejecución. Comparar también con no operar (resultado cero). Si la incertidumbre sigue incluyendo una ventaja nula o negativa, continuar evaluando o descartar; no promover por superar el tamaño mínimo.

## Tarjeta única de preparación pendiente de conectar a evidencia financiera válida

Campos: contratos evaluables/omitidos, operaciones simuladas cerradas, neto con costes, drawdown, exposición pendiente, última captura y bloqueos. Mostrar «no disponible» mientras falten datos. No inventar un porcentaje de preparación sumando controles heterogéneos.

## Paso posterior a demostrar ventaja

Implementar y probar idempotencia de órdenes, ejecuciones parciales, cancelación, reconciliación, reinicio, pérdida de conexión y parada. Revisar límites configurados antes de una prueba supervisada. Mantener la automatización de Codex pausada hasta nueva instrucción. No modificar credenciales ni límites monetarios durante este diagnóstico.
