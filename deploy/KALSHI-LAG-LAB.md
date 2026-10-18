# Prueba prospectiva de retraso

Política brti-book-lag-v1, fijada antes de observar resultados. BTC 15m. Movimiento BRTI mínimo 0,02% en 10s (tolerancia de muestreo 3s), cambio absoluto de precio medio del libro máximo 0,005 USD. Una señal por minuto. No se cambia retrospectivamente esta regla.

Se observa entrada al ask dos segundos después de señal y salida al bid treinta segundos después de entrada, tolerancia 3s; profundidad de un contrato y datos recientes obligatorios. Ventanas ausentes se registran como abstención, no se completan con precios antiguos. Cotas de tarifas verificadas separadas para compra y venta; resultado neto null cuando faltan. Se conserva spread observado. No se incluyen fills, latencia real de órdenes, deslizamiento adicional ni costes operativos: el resultado no acredita beneficio realizable.

Reutiliza el único muestreador de precios existente (2s objetivo, máximo 24h y 64MiB). Consultas de contrato/tarifas compartidas dentro de la prueba cada 10s y libro por captura. Consultas lentas generan intervalos perdidos. Datos y señales se escriben en datos/diagnosticos/kalshi-lag, límite adicional 16MiB por sesión. El panel muestra la sesión actual; los archivos de sesiones anteriores se conservan. No reanuda automatizaciones ni envía órdenes.

GET /api/kalshi-lag y Progreso IA muestran estado, cobertura, señales y resultados. Registro conserva horas de recepción y origen; relojes no equivalentes, correlación no demuestra causalidad. Reiniciar inicia una sesión distinta sin inventar continuidad para pendientes anteriores. No valida subsegundos. Antes de avanzar a demo: exigir recurrencia en varios contratos/días, revisar abstenciones y cobertura, costes, estabilidad sin ajustar la regla con el conjunto de prueba; después probar fills sólo en demo dentro de límites vigentes.

Ocho pruebas relevantes pasaron: timestamps, ejecución demorada, spread/tarifas, abstención, muestreo concurrente y límites de almacenamiento.

## Exploración adicional: minuto de liquidación

Se añadió settlement-minute-observation-v1 como observación descriptiva independiente. Usa lecturas de origen por segundo dentro de [cierre−60s, cierre), sin interpolar huecos ni aceptar lecturas posteriores a la captura. Conserva referencia, umbral, operador, hash de reglas y libro. Calcula promedio ya observado, promedio restante necesario para alcanzar la meta y escenario de precio constante. La discrepancia con el lado del último precio no constituye señal, probabilidad ni beneficio. Las observaciones solapadas no son operaciones independientes. No cambia brti-book-lag-v1 ni sus umbrales.

Fuente de la hipótesis: https://help.kalshi.com/en/articles/13823838-crypto-markets . Debe conciliarse el promedio con el valor oficial antes de interpretar discrepancias como ventaja. Escenario y cobertura disponibles en Progreso IA. Nueve pruebas de referencia, retraso y minuto de cierre aprobadas.

Auditoría reproducible: node scripts/audit-lag-opportunities.js genera datos/diagnosticos/lag-audit.json. Sólo lee archivos con instrumentación del libro, desde su primera sesión. No simula órdenes retrospectivas ni ajusta parámetros.
