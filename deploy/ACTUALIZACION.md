# Ejecución actualizada

## Windows local

Ejecutar `powershell -File scripts/start-production.ps1` desde el proyecto.
Abre http://localhost:3000 con NODE_ENV=production y DEMO=0.
Solo escucha en este equipo. No crea un dominio público ni un servicio que
arranque con Windows. Los registros quedan en datos/logs.

La versión demo puede coexistir en el puerto 3100. Los datos reales dependen
del acceso de cada proveedor; las acciones pueden usar datos demo si falta
su conexión, y deben interpretarse con la fuente que presenta la pantalla.

## Docker y servidor Linux

El objetivo `neural` instala Python y TimesFM. No incluye el entorno virtual
de Windows, pesos, registros privados ni secretos del equipo de desarrollo.
El objetivo `base` permite desplegar sin inferencia neuronal.

Con Docker y Compose instalados, preparar `.env` de forma privada y ejecutar:

```sh
docker compose build
docker compose run --rm app /opt/forecast-venv/bin/python forecast/worker.py --prepare
docker compose up -d
```

Los modelos y datos operativos persisten en volúmenes. La descarga requiere
acceso a Hugging Face. Verificar espacio y memoria para TimesFM antes de
elegir el servidor. El contenedor escucha solo en el puerto local 3000 del
servidor. Nginx admite hasta 210 segundos para la inferencia neuronal.

Para systemd, crear data y datos dentro del proyecto, asignarlos al usuario
mtp y preparar .venv-forecast con forecast/requirements.txt. El servicio
permite escribir únicamente en esos directorios. Configurar el dominio
real y TLS antes de exponer el servidor.

## Agente y credenciales

El código actual conserva el proveedor Anthropic existente. Una credencial
presente no demuestra acceso válido. La última comprobación devolvió 401.
La conexión nueva de OpenAI no se creó: el destino de guardado fue rechazado.
No se sustituyen ni se generan secretos durante esta actualización.

El bot continúa en simulación. Se ejecuta de forma independiente con
`npm run agente -- --agente --web`; requiere credencial válida y las reglas
de cada serie aprobadas por el operador. El servidor web no lo inicia solo.

Kalshi requiere su propia clave y archivo privado para el índice oficial.
El alojamiento público y sus credenciales siguen pendientes de selección.

## 2026-10-05 — Mantenimiento API Kalshi y datos en vivo

Se verificó https://kalshi.com/docs/kalshi-fee-schedule.pdf (efectivo 2026-07-07): coeficiente taker 0,07 y sin tarifa de liquidación. Se conserva la cota conservadora de comisiones; no equivale a importe cobrado. src/kalshi-fee-policy.js registra fuente, versión de revisión y próxima revisión 2026-10-12 UTC. No hay extensión automática de vigencia. Cada preflight sigue comprobando multiplicadores y cambios de tarifas de serie/evento. Prueba conectada de lectura: verified=true, upperBound=0,03 USD. /api/learning y Progreso IA muestran vigencia.

Conciliación: snapshot consulta primero todas las secciones de órdenes recientes y después /historical/orders paginado. Deduplica únicamente coincidencias y bloquea si hay conflicto o falta el archivo. Fuente: https://docs.kalshi.com/getting_started/historical_data. No sustituye una liquidación archivada por una cifra inferida. Prueba DEMO: 2 órdenes recientes, 0 archivadas; orden cancelada sigue ausente y GET directo 404. Saldo 99,9839 USD ficticios, reservas 0,18 USD, sin posiciones ni órdenes abiertas. Baseline permanece vencido; no se borra historial ni se habilitan entradas.

Liquidez: se retiró uso de liquidity_dollars; se conserva null y se registran yes_bid_size_fp/yes_ask_size_fp en contratos al mejor nivel, sin convertir cantidades en falsa liquidez monetaria. Liquidaciones no estándar (settlement_bounds_type distinto de default) se excluyen del ejecutor y de la prueba económica que supone pagos 0/1.

WebSocket: src/kalshi-websocket.js autentica el handshake, fija hosts demo/producción, usa Ping/Pong nativos, controla secuencia/suscripción, precisión fija, timestamps y reconstrucción de snapshot/deltas. Ante errores, huecos, libro cruzado o desconexión descarta el libro. Cierre detiene reconexiones y el socket; reintentos con espera creciente. src/kalshi-market-feed.js integra lectura del contrato BTC15m en el recolector existente y REST de respaldo identificado. No modifica el ejecutor ni manda órdenes. No confunde retraso de mensajes con desfase de reloj. Evita ordenar/copiar el libro en cada delta cuando nadie escucha el evento.

Prueba conectada de solo lectura: 5 mensajes consecutivos, sin huecos, 108/171 niveles YES/NO; evidencia datos/diagnosticos/kalshi-ws-connected.json. Servidor habitual también confirmó WebSocket listo y 4.366 mensajes sin huecos durante la verificación. Interfaz Progreso IA muestra libro reciente y tarifas revisadas.

Dependencias: @anthropic-ai/sdk 0.131.0 y ws 8.22.0 fijados con lockfile; Express se conserva en su versión compatible. Suite: 692 aprobadas, 1 omitida, 0 fallos; después 13 pruebas focalizadas incluyendo liquidación no estándar y 4 del último ajuste WebSocket. Log datos/diagnosticos/kalshi-updates-tests.log. App reiniciada. No órdenes, credenciales, límites o automatizaciones modificados. Pendiente conciliación completa demo; ninguna afirmación de preparación o rentabilidad real.
