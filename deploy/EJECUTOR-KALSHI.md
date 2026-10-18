# Ejecutor Kalshi: implementación desactivada

2026-09-28. Módulos `src/kalshi-executor.js` y `src/kalshi-order-transport.js`.

Estado: pruebas locales con proveedor simulado. Sin órdenes enviadas a demo ni producción, sin nuevas credenciales, sin cambios de riesgo. No conectado a rutas HTTP, botones ni ciclo del bot. Importar el módulo no lo activa. El adaptador predeterminado apunta a demo y rechaza escrituras; el motor también comienza desactivado.

## Funciones implementadas

- Conversión de compras YES/NO y ventas a V2, precio limitado a centavos enteros y cantidades enteras. IOC y reducción de posición en ventas; no hay órdenes de mercado ni apalancamiento.
- Firma RSA-PSS de método y ruta, sin reintentos de mutaciones ni redirecciones.
- Confirmación exacta mediante huella del contrato, lado, acción, cantidad, precio, comisión máxima y caducidad. Esta huella es un contrato interno de programación, no autenticación de usuario; no debe aceptarse desde una ruta pública sin controles adicionales.
- Registro en disco antes del envío, bloqueo entre instancias, idempotencia persistente y conservación de reservas tras reinicio.
- Ante timeout, respuesta inválida o estado incierto: bloqueo de nuevos envíos y consulta posterior por ID. No encontrar la orden no autoriza repetirla.
- Cancelación seguida de consulta; una ejecución parcial conserva exposición. Costes ausentes o superiores a reserva bloquean el estado.
- Límites acumulados incluyen reservas, exposición externa, pérdidas y comisiones. No se reutilizan ganancias ni se libera el presupuesto de órdenes con fills automáticamente, tampoco a medianoche. Es conservador y no constituye contabilidad diaria definitiva.

## Pendiente antes de considerarlo operativo

Implementado `src/kalshi-execution-preflight.js`: consultas autenticadas paginadas, saldo antes/después, conciliación de costes, comisiones, posiciones y liquidaciones contra un inicio sin posiciones. El piloto acepta solamente actividad propia; movimientos externos, depósitos/retiros o diferencias bloquean. Las pérdidas están cubiertas por las reservas brutas conservadas, no se vuelven a sumar ni se permite reutilizar ganancias. La sesión caduca a las 24 horas; no es contabilidad general para una cuenta compartida. El motor relee pausa y límites después de la consulta.

Las tarifas se consultan por serie y cambios del evento. Modelos desconocidos o cambios dentro de la ventana bloquean. La reserva es una cota conservadora para precios mejorados y redondeos, no una cotización exacta; las comisiones cobradas se concilian posteriormente. Fórmula base revisada contra la documentación el 28-09-2026, revisión obligatoria antes del 05-10-2026. Las reglas se aprueban mediante huella exacta y cualquier modificación invalida esa aprobación.

Falta validar contra Kalshi demo con credenciales separadas: permisos, tick sizes por contrato, fills, tarifas, rechazo, pérdida de conexión y cancelación; posteriormente auditoría del flujo de autorización y conciliación de liquidaciones. Las pruebas con mocks no demuestran compatibilidad real ni rentabilidad. La preparación de producción permanece roja.

## Prueba demo separada

Crear cuenta en https://demo.kalshi.co y una clave de API de ese entorno. Configurar exclusivamente `KALSHI_DEMO_API_KEY_ID` y `KALSHI_DEMO_PRIVATE_KEY_PATH` en `.env.demo` local (ignorado por Git). No usar la clave real. Nunca pegar la clave privada en el chat. El programa no modifica la configuración real ni sus límites.

`node scripts/validate-kalshi-demo.js check` comprueba acceso y saldo sin enviar órdenes.

`node scripts/validate-kalshi-demo.js init` crea una única base contable si la cuenta está sin posiciones ni órdenes abiertas. No sobrescribe bases existentes. `inspect TICKER` muestra reglas y huella; `approve-rules TICKER HUELLA` registra su revisión. `verify TICKER yes buy 1 0.10 0.02` prueba la verificación previa sin enviar. `submit TICKER yes buy 1 0.10 0.02` envía exclusivamente una orden demo explícita; ticker y valores son ejemplos, no una elección de mercado. `reconcile CLIENT_ID` y `cancel CLIENT_ID` operan únicamente sobre el registro demo. No hay ruta HTTP ni conexión automática al bot.

Los resultados están en `datos/executor-demo/last-check.json`. El intento de esta entrega quedó bloqueado por falta de credenciales demo; no se ejecutó una orden contra Kalshi. Incluso un envío demo exitoso no acredita por sí solo parciales, cancelaciones o rentabilidad; cada escenario requiere su evidencia.

Un lock residual requiere investigar el proceso y consultar las órdenes antes de retirarlo. No borrar ni editar el registro para recuperar presupuesto. Conservar copias; pérdida o manipulación del registro invalida la reconciliación. No hay tareas programadas nuevas.

## Verificación reproducible

`node --test test/kalshi-executor.test.js test/trading-settings.test.js test/supervised-ticket.test.js test/production-readiness.test.js test/proposal-review.test.js`

Las pruebas usan directorios temporales, claves RSA generadas para tests y HTTP simulado. No acceden a la cuenta ni envían órdenes.

Resultado de esta entrega: 27 pruebas específicas aprobadas; suite completa 628 pruebas, 627 aprobadas, 1 omitida, 0 fallos. Registro: `datos/diagnosticos/executor-tests.log`. Servidor reiniciado y estado de preparación verificado con ejecución desactivada.

Ampliación contable: 21 pruebas de ejecutor/integración aprobadas. Suite completa: 637 pruebas, 636 aprobadas, 1 omitida, 0 fallos (`datos/diagnosticos/executor-accounting-tests.log`). GET público de exchange/status demo respondió activo; autenticación y órdenes demo no probadas por falta de credenciales.

## Corrección de secciones del exchange, 28-09-2026

La autenticación demo funciona. Tras el primer intento, se descubrió que el saldo ficticio de 100 USD estaba en exchange_index 0 y Bitcoin pertenecía al 2, sin saldo. El primer envío perdió el detalle de su error; no se presenta esa causa como rechazo demostrado. Se corrigieron las consultas de órdenes por mercado, la agregación contable por sección y la comprobación del saldo específico del contrato, en lugar de usar el saldo total como capacidad de compra.

Los errores posteriores conservan código HTTP y código del proveedor sin cuerpos sensibles. Recuperación restringida a la primera orden demo sin ID: exige mercado cerrado por más de un minuto, cuenta vacía en todas las secciones, cero fills y saldo igual al inicial. Marca ausencia auditada y conserva toda la reserva, nunca repite ese ID. No disponible en producción. La financiación interna de pruebas está restringida en el adaptador a demo y como máximo 1 USD ficticio por llamada explícita; no reintenta transferencias.

Regresión: 640 pruebas, 639 aprobadas, 1 omitida, 0 fallos (`datos/diagnosticos/demo-recovery-tests.log`). Referencia: https://docs.kalshi.com/getting_started/exchange_sharding.

## Fuentes oficiales consultadas

- https://docs.kalshi.com/api-reference/orders/create-order-v2
- https://docs.kalshi.com/api-reference/orders/get-order
- https://docs.kalshi.com/api-reference/orders/cancel-order-v2
- https://docs.kalshi.com/getting_started/fee_rounding
- https://docs.kalshi.com/api-reference/events/get-event-fee-changes
- https://docs.kalshi.com/api-reference/exchange/get-series-fee-changes
- https://kalshi.com/docs/kalshi-fee-schedule.pdf

Estas notas actualizan el estado histórico de `PRODUCCION-SUPERVISADA.md`: el código existe, pero el ejecutor sigue desactivado y sin validación de integración.

## Resultado demo confirmado, 29-09-2026 02:47 UTC

Actualiza los estados históricos anteriores: se auditó la ausencia del primer intento después del cierre, sin fills, posiciones ni cambios de saldo; su reserva de 0,08 USD permanece. Se asignó 1 USD ficticio del índice 0 al 2, conservando 100 USD totales. Kalshi aceptó la segunda orden IOC (cliente 50cec946-90ef-47b6-a98f-cd73da4085c2); terminó cancelada automáticamente con cero contratos ejecutados, coste cero y comisiones cero. La consulta individual requiere exchange_index explícito. También se usa exchange_index=0 explícito en la contabilidad, pues omitirlo puede devolver órdenes agregadas y duplicarlas al combinar secciones.

La verificación contable posterior pasó: saldo total 100 USD, sección cripto 1 USD, exposición y pérdida realizadas cero. Evidencia: datos/executor-demo/trial-report.json y last-check.json. Regresión final: 641 pruebas, 640 aprobadas, 1 omitida, cero fallos (datos/diagnosticos/demo-recovery-final-tests.log).

Validado únicamente el envío y consulta del camino sin ejecuciones. Faltan compras y ventas ejecutadas con tarifas reales demo, parciales, cancelación explícita, recuperación de red y liquidaciones. No se activó el bot autónomo; producción continúa desactivada y sin validación completa.

## Compra y venta ejecutadas en demo, 29-09-2026 02:54 UTC

Prueba técnica de un contrato YES KXNFLTOTAL-26OCT05ATLNO-70: compra 0,05 USD, comisión 0,0034 USD; venta 0,04 USD, comisión 0,0027 USD. Resultado neto -0,0161 USD ficticios; saldo 100 -> 99,9839 USD. Sin posiciones ni órdenes abiertas. Ambas ejecuciones se contrastaron con fills, registro de órdenes y saldo total. No cambió ningún límite.

La API V2 representa el coste de ask en el resultado NO. Para cerrar YES, el ingreso es cantidad ejecutada menos dicho coste: 1 - 0,96 = 0,04 USD. Se normalizó ese valor en ejecutor y reconciliación, conservando rawOutcomeCost; pruebas cubren ambos lados y cantidad parcial. Las consultas inmediatas devolvieron 404 transitorio; la reconciliación posterior recuperó las mismas órdenes sin reenviarlas.

Evidencia: datos/executor-demo/roundtrip-report.json. La prueba valida este recorrido completo de compra/venta y tarifas, no rentabilidad, parciales reales, cancelación explícita ni recuperación automática. Producción y bot autónomo siguen desactivados. Tarifas/redondeo contrastados con https://docs.kalshi.com/getting_started/fee_rounding y formato de órdenes con https://docs.kalshi.com/api-reference/orders/get-order .

## Piloto de decisiones con TimesFM, 28-09-2026

Implementado src/kalshi-demo-strategy.js y scripts/kalshi-demo-strategy.js. Es un piloto CLI separado de los botones del bot web, exclusivamente demo, inicialmente BTC 15m. Lee /api/neural-forecast de la app, contrasta fuente consolidada USD y cierre exacto con contrato demo. Conserva predicción, cuantiles, modelo, fechas, meta y motivo antes del envío en datos/executor-demo/strategy-decisions.jsonl; estado más reciente en strategy-status.json. No interpreta una estimación puntual como probabilidad calibrada ni supone equivalencia con la liquidación BRTI.

Entrada experimental: 1 contrato cuando todos los cuantiles centrales están por encima/debajo de la meta, con más de 2 minutos restantes. Una tentativa por contrato. Salida reduce-only al perder apoyo de la banda, faltar/caducar la predicción, obtener 0,05 USD brutos por contrato o entrar en el último minuto. Sin comprador no promete salida. Tarifas consultadas mediante preflight; reserva adicional de 0,03 USD para salida y los límites existentes permanecen. Bloquea duplicados, pendientes y presupuesto insuficiente. Consulta nuevamente órdenes desconocidas sin repetir mutaciones.

Uso: node scripts/kalshi-demo-strategy.js (evaluación sin órdenes); --execute habilita exclusivamente órdenes DEMO. --cycles=1..20 limita la sesión; separación mínima 15 s e inferencia hasta 180 s. No es servicio permanente ni tarea programada; al terminar deja de vigilar, incluso si queda una posición. Sin automatización nueva ni cambio al bot web.

Primera evaluación conectada: contrato KXBTC15M-26SEP282300-00, meta 82975,22 USD, TimesFM 83016,421875 USD, banda 82744,5546875–83290,7421875 USD. Decisión: esperar por menos de dos minutos restantes. No se envió ninguna orden. La banda también atravesaba la meta. El presupuesto global conserva 0,18 de 0,20 USD; no se liberó ni elevó artificialmente.

Pendiente en demo: entrada y salida motivadas por predicciones, cambios de señal, pérdida del servicio neuronal, liquidez insuficiente y ejecuciones parciales reales, cancelación explícita, reinicio con posición abierta, liquidación oficial y prueba prospectiva de P&L neto frente a baseline. Las pruebas unitarias de esas decisiones no sustituyen esas pruebas conectadas.

## Selección del motor por evidencia, 29-09-2026

El piloto demo ya no fuerza TimesFM. Compara TimesFM, IA local y la referencia de mantener el consolidado, los tres de la comparación de aprendizaje. Usa contratos oficiales con pronósticos congelados en la ventana de 10 minutos, el mismo grupo de fuente/proveedores/versiones y resultados conocidos antes de decidir. Prioridad: acierto YES/NO; desempate por MAE de precio. No usa MAE de vela como si fuera liquidación Kalshi.

Última evaluación: 16 contratos, consolidado 12 aciertos y MAE 76,67375 USD; IA local 12 y MAE 90,02366396; TimesFM 8 y MAE 107,24078125. Selección provisional: mantener consolidado. No es superioridad estadística ni rentabilidad demostrada.

Para emitir una señal operable exige al menos 50 contratos: selección sobre los anteriores a los últimos 20 y calibración residual sobre esos 20 posteriores. No reutiliza cuantiles de TimesFM para otro motor. Ese mínimo es una condición experimental, no certificación. Si falta histórico, predicción reciente del contrato/meta exactos o intervalo, no abre. Las salidas de protección continúan sin depender del ganador. No añade recolección ni tareas; lee el registro del recolector existente.

Resultado y motivo visibles en datos/executor-demo/strategy-model-selection.json y strategy-status.json. Entradas bloqueadas con 16 casos; no hubo órdenes en esta revisión. Sin cambio de presupuesto, producción ni modelo principal de la app. Sustituye la lectura directa de /api/neural-forecast descrita en la sección anterior para este piloto.

Corrección de recolección 29-09-2026 07:12 UTC: captura BTC15m v2 deduplica por 30s con nuevo prefijo, preservando histórico v1. Evita descartar una segunda observación válida dentro del mismo minuto. No cambia ventana de evaluación, fuente ni reglas de selección. 15 pruebas aprobadas; primer evento v2 verificado después del reinicio.
