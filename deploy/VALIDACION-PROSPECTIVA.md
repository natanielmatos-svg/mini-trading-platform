# Piloto local de validación

El bot continúa en simulación. Capital y pérdida diaria siguen siendo configurables; no se implementó ni activó envío de órdenes reales.

## Cambios

- BTC/KXBTCD: hasta doce strikes próximos al índice, con cierre entre dos minutos y una hora. Otros activos siguen disponibles en el análisis visual, no en este piloto.
- El bot obtiene precio e histórico del mismo índice BRTI mostrado como referencia en la app. Guarda minutos completos de 60 segundos distintos en `datos/indices/BRTI.json`; no rellena huecos. Necesita 400 minutos continuos y recientes. Los reinicios conservan el histórico.
- Las distribuciones del piloto usan velas de un minuto del índice. El precio instantáneo aún no equivale al promedio de liquidación: las entradas permanecen bloqueadas incluso después del calentamiento hasta validar reglas, objetivo y tarifas.
- `datos/evidencia.jsonl` conserva la primera observación de cada contrato, versión y tramo temporal, incluidos rechazos y decisión antes del veto. No reconstruye pronósticos a posteriori. Resuelve únicamente resultados oficiales `settled`, con reintentos y deduplicación tras reinicio.
- `/api/evidence` y la tarjeta «¿Hay ventaja medida?» muestran observaciones, pendientes y Brier frente al punto medio de Kalshi. Solo se comparan probabilidades disponibles del mismo contrato; las franjas correlacionadas no se presentan como muestras independientes.
- Libro firmado de Kalshi: lectura posterior al análisis, rechazo si falta profundidad o tiene más de diez segundos, tamaño limitado al 25% del mejor nivel. Cierres parciales conservan cantidad y comisión de entrada proporcional tras reinicio. No hay barrido de niveles ni supuesto de liquidez infinita.
- Liquidaciones y salidas por presupuesto se gestionan antes del listado, modelo y agente. Salidas por valoración necesitan una predicción válida; si falta, no se inventa una. Con posiciones pendientes o supervisor de evidencia el proceso conserva sus reintentos tras fallos.
- TimesFM muestra dirección estimada separada de ventaja demostrada. Sus 24 casos históricos continúan siendo insuficientes para acreditar rentabilidad.

## Qué falta para operar

Validar el objetivo exacto de cada contrato y su calendario de comisiones; medir resultados fuera de muestra con costes de IA, latencia y ejecución; comparar TimesFM sobre el mismo objetivo; implementar y probar órdenes reales, fills, cancelaciones, reconciliación y recuperación del servicio. La ejecución en papel al mejor nivel sigue siendo una aproximación conservadora, no una reproducción de la cola del exchange.

No hay rentabilidad demostrada por instalar estos cambios ni por superar pruebas de software. La máquina debe permanecer encendida y conectada para recopilar datos; no se instaló arranque automático de Windows.

Referencia del libro: https://docs.kalshi.com/api-reference/market/get-market-orderbook
