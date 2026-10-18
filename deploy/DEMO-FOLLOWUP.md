# Seguimiento de validación demo

Estado inicial: presupuesto separado, 19,99 USD ficticios acumulados por campaña y 1,03 USD por orden incluyendo tarifas. Reservas iniciales conservadas: 0,18 USD. Límites reales intactos. No hay reinicio automático de presupuesto ni autorización para aumentar los límites.

Usar datos/executor-demo/settings.json, nunca datos/trading-settings.json. scripts/validate-kalshi-demo.js y scripts/kalshi-demo-strategy.js ya usan configuración demo. La cuenta demo respondió con 99,9839 USD ficticios. 41 pruebas específicas aprobadas.

## Evidencia necesaria
- Compra/venta técnica con fills, comisiones y saldo: comprobada en roundtrip-report.json; aún no demuestra estrategia rentable.
- Selección sin datos futuros: implementada; 16 contratos disponibles, 50 requeridos para separar selección y calibración. No reducir el mínimo para forzar operaciones.
- Entradas/salidas causadas por predicciones: pendiente evidencia prospectiva conectada.
- Parciales, cancelación explícita, liquidez ausente, 404 transitorio, desconexiones, reinicio, pausa y conciliación de liquidación: distinguir pruebas simuladas de pruebas realmente observadas en demo.
- Contabilidad por shard, reservas e idempotencia: conservar histórico; nunca borrar ledger o reutilizar IDs para recuperar presupuesto.
- El inicio contable tiene validez de 24 horas: al vencer, bloquear y construir renovación auditada conservando pérdidas, reservas e histórico antes de continuar. Nunca reiniciar baseline sin conciliación.
- Las tarifas tienen revisión de vigencia; si vencen, comprobar documentación vigente y cubrir con pruebas antes de continuar.
- Preparación de producción requiere resolver defectos críticos, robustez operativa y mejora prospectiva independiente neta de comisiones/spread frente a baseline. Documentar incertidumbre y muestras; ni 50 casos ni P&L positivo aislado certifican rentabilidad.

## Procedimiento por revisión
Leer EJECUTOR-KALSHI.md, este archivo y registros demo. Consultar /api/learning y comprobar recolección sin duplicarla. Ejecutar check, conciliar pendientes, examinar posiciones y sesiones activas. Ejecutar el piloto primero sin órdenes; ejecutar --execute en sesiones acotadas solo si las validaciones permiten. Autorizar únicamente órdenes ficticias demo. Si queda una posición abierta, supervisarla durante la sesión y gestionar salida o liquidación; no dejarla inadvertida hasta la próxima revisión. Una sesión no es un servicio permanente.

Preservar settings reales, credenciales y automatización neuronal pausada. No realizar pagos, contratar servicios, enviar mensajes externos ni habilitar producción. Si faltan fondos del shard, se permite asignar hasta 1 USD ficticio por llamada mediante el helper demo, verificando resultado y saldo sin reintentos ciegos ni superar el presupuesto.

Guardar progreso y matriz de validación en datos/executor-demo/followup.md. Mantener bloqueos concretos con fecha, prueba y siguiente acción. Corregir software reversible con pruebas, preservando cambios ajenos. Avisar solo ante hitos, errores nuevos o intervención necesaria. Al estar todo respaldado por evidencia, entregar informe de preparación; la activación real requiere una decisión separada y explícita del usuario.

Corrección vigente: capital 99,98 USD calculado únicamente del saldo Kalshi DEMO de 99,9839 USD. Prohibido usar saldo real para dimensionar estas pruebas. La referencia anterior a producción quedó anulada.

## Separación de responsabilidades — 2026-09-29

El bot de estrategia demo es el único flujo de nuevas órdenes. La CLI técnica rechaza submit; sigue disponible para inspección, conciliación y cancelación. El transporte exige role=bot además de allowWrites; observador/supervisor no puede enviar, cancelar ni transferir. Esto separa capacidades de aplicación, no constituye aislamiento frente a código con acceso al equipo.

El identificador clientId se guarda con la predicción y decisión antes del envío y se reutiliza en el ejecutor; no se regenera después. El agente no dispone de herramienta de órdenes. Modelo activo y límites solo cambian mediante validación aparte.

Panel Bot ejecutor / Kalshi DEMO: iniciar sesión acotada, pausar, reanudar y solicitar detención. Pausa y detención se comprueban también en preflight; no modifican ajustes reales ni límites demo. La detención deja de abrir y termina al estar plano. Sesiones de 20 ciclos, no vigilancia permanente; una posición que no pueda cerrarse exige seguimiento hasta salida o liquidación. No iniciar una sesión y abandonarla. Simulador de investigación claramente separado de operación demo.

Pruebas específicas: 30 aprobadas, incluyendo denegación de mutaciones al supervisor. No se enviaron órdenes ni se activó producción al implementar esta organización.

## 2026-09-30 — Control de entrada económico
Nuevas entradas de scripts/kalshi-demo-strategy.js requieren kalshi-economic-gate además de las verificaciones existentes. La tasa de acierto y una banda a un lado de la meta no autorizan entrada. Se exige evidencia prospectiva para la política de salida anticipada y valor conservador neto de costes; no se utiliza directamente probabilidad de liquidación como retorno de esa política. Aún no existe productor validado de dicha evidencia: bloqueo deliberado de entradas nuevas. Salidas conservadas. Límites, reservas y automatizaciones pausadas intactos. Véase datos/executor-demo/followup.md.
