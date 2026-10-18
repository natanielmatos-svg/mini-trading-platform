# Preparación supervisada con capital de 20 USD

La instalación local está en http://localhost:3000. No está habilitada para enviar órdenes reales. No se implementó un ejecutor autónomo.

## Panel de control

En Bot y agente → Capital y límites → Preparación para operación real, «Comprobar preparación y cuenta» consulta únicamente GET de saldo, órdenes abiertas y posiciones en Kalshi. Caché de 60 segundos; una consulta incompleta o fallida no se declara verificada. No expone claves ni firmas. El saldo no se reserva ni se transfiere. La lectura satisfactoria no acredita autorización para negociar.

GET /api/production-readiness expone la comprobación exclusivamente en el servidor local y devuelve siempre ready:false y liveEnabled:false mientras falte ejecutor y validación. La app nunca presenta producción del servidor como producción de trading.

## Bloqueos verificados

- La consulta autenticada de lectura funciona, pero el saldo disponible observado no cubre 20 USD. No se realizó depósito ni transferencia.
- Capital local 20 USD, porcentaje diario 1% (0,20 USD), máximo configurado por operación 0,50 USD. El panel señala la incompatibilidad conservadora entre exposición y presupuesto. No se alteraron porcentajes ni importe por operación.
- Validación pendiente de objetivo de liquidación y tarifas por serie. BRTI instantáneo no equivale al promedio final del contrato.
- No existe ejecutor real probado: órdenes, identificadores idempotentes, ejecuciones parciales, cancelaciones, conciliación con el exchange y recuperación requieren implementación y validación supervisada.
- Ventaja prospectiva neta de costes no demostrada.

## Operación y recuperación

Mantener equipo y conexión activos. Arranque local: scripts/start-production.ps1 (rechaza un puerto ocupado). Revisar /healthz, /api/learning y el panel antes de asumir que el bot está activo. «Pausar entradas» permite que el bot simulado siga supervisando salidas; «Detener bot» detiene ese proceso y no liquida posiciones. Ninguno de estos controles administra posiciones reales de la cuenta.

Cada operación real debe ser revisada y confirmada por el usuario directamente en Kalshi. El enlace del panel abre la plataforma; no transmite una orden, cantidad ni credenciales. Un límite local no impide acciones manuales fuera de la app ni garantiza pérdidas máximas.

## Validación de esta entrega

Pruebas de estado no verificado, lectura vieja/incompleta, presupuesto, modo demo y bloqueo de ejecución. Verificación local del endpoint y del panel. Regresión completa registrada en datos/diagnosticos/production-tests.log. Se corrigió el detector de dependencias del test compartidos para reconocer scripts versionados mediante query string; los módulos reales ya estaban cargados.

Referencia de autenticación y lectura: https://docs.kalshi.com/getting_started/quick_start_authenticated_requests
