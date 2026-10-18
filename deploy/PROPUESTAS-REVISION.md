# Propuestas revisables

## Ficha de revisión supervisada

«Revisar contrato y coste en Kalshi» abre una ficha independiente del refresco de tarjetas. GET /api/proposals/:id/ticket consulta el mercado público oficial y la cuenta, vuelve a comprobar la propuesta después de la consulta, muestra reglas de liquidación, ofertas Sí/No en USD, precio límite propuesto, cantidad, coste y comisión estimados, saldo y límites. Señala caducidad (máximo 15 segundos desde el inicio), sustituciones, cuentas incompletas, mercado cerrado y precio peor. Si faltan importes, muestra «No disponible».

Copiar contrato y abrir Kalshi son ayudas para revisión manual: no prellenan ni envían órdenes. La confirmación final y la comisión final se revisan en Kalshi. El presupuesto diario mostrado es configurado, no restante: todavía no existe reconciliación suficiente para certificar riesgo real ni comisión exacta. La ficha no declara el bot listo para producción. Las ejecuciones reales se observan en Cuenta Kalshi según lo reporte su API, sin atribuirlas automáticamente a una propuesta local.

Fuente de contrato y unidades: https://docs.kalshi.com/api-reference/market/get-market. Validación adicional: test/supervised-ticket.test.js (lectura sin ejecución, límites, caducidad durante consulta, sustitución, cuenta incompleta y fallos de proveedor).

Bot y agente → Propuestas del bot muestra las últimas evaluaciones por contrato (máximo 12), tomadas del registro real de decisiones del bot. No crea oportunidades sintéticas ni ignora vetos. Precio del activo nunca se presenta como precio de contrato si falta una entrada válida.

Cada propuesta conserva hash del contenido exacto, precio, cantidad, comisión estimada, coste, motivo, fuente y vencimiento de revisión (máximo 60 segundos). El servidor vuelve a leer la evaluación y los límites al revisar. Una propuesta sustituida, vencida, vetada, sin importe válido, fuera de límites o con bot detenido/pausado no puede aprobarse. Rechazar sí permite archivar una evaluación bloqueada. Repetir la misma decisión es idempotente; no permite cambiar una revisión anterior.

Aprobar registra conformidad local, no autoriza una orden futura, no ejecuta, no reserva saldo y no sustituye validación de libro/riesgo real. No hay endpoint de envío. El historial persiste en datos/proposal-reviews.json con hasta 1000 revisiones y conserva el contenido aprobado. UI muestra las 20 últimas. No se enviaron órdenes de prueba ni se aprobaron propuestas del usuario durante las pruebas.

Validación: pruebas con archivos temporales para aprobación, persistencia, idempotencia, expiración, sustitución, bloqueo, validación de importes y corrupción de registro. Endpoint local devuelve 12 evaluaciones y cero aprobables en la comprobación inicial.
