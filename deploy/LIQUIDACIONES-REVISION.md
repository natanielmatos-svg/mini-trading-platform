# Corrección de liquidaciones oficiales

El consumidor aceptaba sólo `settled` mientras la API devuelve `finalized`. El nuevo adaptador acepta ambos estados finales, exige coincidencia de ticker y resultado yes/no, y rechaza resultados provisionales y estados no finales. Conserva estado oficial y settlement_ts en el registro. No reconstruye pronósticos ni altera probabilidades guardadas. Mercados finalized/determined/disputed/amended se excluyen de entradas.

Recuperación realizada con bot detenido para evitar escritores simultáneos y copia previa del JSONL. Se recuperaron 346 contratos, resolviendo 609 de 625 observaciones; 16 observaciones permanecían pendientes al terminar. Primera pasada: 313 contratos y 33 errores de consulta. Segunda pasada secuencial con separación de 500 ms: los 33 recuperados, cero errores. El script scripts/reconcile-evidence.js exige proceso detenido y respeta resultados ya registrados.

Comparaciones emparejadas del registro al terminar (Brier menor es mejor):

| Horizonte | Pares | Modelo | Referencia Kalshi |
|---|---:|---:|---:|
| 15–60 minutos | 226 | 0.125916 | 0.119323 |
| 2–15 minutos | 135 | 0.104586 | 0.102292 |

Estas observaciones incluyen strikes correlacionados; no representan 361 eventos independientes. Son errores de probabilidad, no beneficios de operaciones. No hay rentabilidad demostrada ni autorización para retirar el bloqueo de liquidación objetivo/tarifas. Las etiquetas oficiales resuelven la evaluación, pero no validan que el modelo prediga el promedio de liquidación correcto. Límites y credenciales sin cambios.

Validación: 29 pruebas aprobadas (adaptador de liquidación, evidencia y mercados), incluyendo resultados finales/provisionales, persistencia y deduplicación. Bot reiniciado en su modo simulado existente.
