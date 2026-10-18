# Cuenta Kalshi en la app

Tarjeta «Mi cuenta Kalshi» en Bot y agente, disponible también mediante Elegir tarjetas de Resumen. Acceso de solo lectura desde el servidor local, sin claves ni identificadores de usuario en el navegador. No envía órdenes ni mezcla el ledger simulado.

/api/kalshi-account consulta saldo, posiciones, órdenes, ejecuciones y liquidaciones. Caché de 30 segundos, actualización visible cada 60 segundos y botón manual. Cada colección recorre hasta 10 páginas de 100 registros; interrupciones, cursores repetidos y límites se señalan. Los endpoints recientes de órdenes/fills no garantizan historial completo; no se anuncian resultados de toda la vida de la cuenta. Títulos de hasta 50 contratos por respuesta, ticker disponible para el resto.

Dólares fixed-point conservan decimales; campos monetarios antiguos en céntimos se dividen por 100. Posiciones conservan signo Sí/No. P&L reportado se mantiene tal como Kalshi lo entrega, separado de comisiones. Las liquidaciones muestran resultado oficial del contrato, cantidades Sí/No, costes, cobro y comisión. No calcular beneficio sumando cobros menos costes de liquidación: puede faltar la venta o compensación previa. Un campo ausente es «No disponible», nunca cero inventado.

Validación: 30 pruebas de normalización, paginación, dependencias y preparación; lectura real y verificación de tarjeta en navegador. Documentación contrastada: https://docs.kalshi.com/api-reference/portfolio/get-balance, /get-positions, /get-fills, /get-settlements.

## Actualización frecuente

La tarjeta consulta cada 5 segundos mientras la pestaña está visible, sin solapar solicitudes. La caché compartida baja a 1 segundo y saldo, posiciones, órdenes, fills y liquidaciones se consultan en paralelo. Registra inicio y recepción por sección; la UI cuenta segundos desde inicio de consulta y marca datos atrasados (>15 s), parciales o fallos de conexión. Conserva las tablas desplegadas y su desplazamiento. Es sondeo REST, no transmisión instantánea WebSocket. La API de Kalshi también puede reflejar cambios con retraso. Las operaciones reales se siguen confirmando directamente en Kalshi; no se modificó el riesgo ni se enviaron órdenes.
