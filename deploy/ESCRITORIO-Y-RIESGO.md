# Escritorio y control de riesgo

Las páginas de cripto, acciones y predicciones incluyen tarjetas con posición y tamaño guardados por página en el navegador. Arrastra la barra superior o la esquina inferior derecha; también admiten flechas y Mayús para pasos mayores. Restablecer distribución recupera el diseño inicial. En pantallas estrechas se apilan para mantener los controles accesibles.

La estimación neuronal se actualiza al seleccionar activo o intervalo y al abrir un nuevo bloque, mientras la página está visible. El cálculo usa velas completas de la fuente indicada; no incorpora automáticamente todas las noticias ni equivale al índice de liquidación de Kalshi. Un resultado tardío o una serie incompleta se rechaza. La casilla permite desactivar la actualización automática.

Configuración local: datos/trading-settings.json, excluida de Git. Desde Capital y límites se modifica capital, pérdida diaria porcentual, máximo por operación opcional y pausa de nuevas entradas. El bot lee cambios en cada ciclo. Capital inicial autorizado: 50 USD; pérdida diaria: 5% (2,50 USD); tamaño automático. El día contable es UTC. Se reserva también el coste de las posiciones abiertas, incluidas comisiones, contra el presupuesto diario. Reducir el capital no liquida posiciones previas. La pausa conserva las revisiones de salida.

El proceso iniciado sigue SIMULANDO Bitcoin; no envía órdenes. El estado visible procede de una señal del proceso cada 15 segundos y caduca tras 45 segundos. Los pronósticos de la página no cambian silenciosamente el activo del bot.

## Pendiente antes de dinero real

- Configurar KALSHI_API_KEY_ID y KALSHI_PRIVATE_KEY_PATH en .env, sin publicar el PEM ni copiarlo al chat. Autenticación oficial: https://docs.kalshi.com/getting_started/quick_start_authenticated_requests
- Implementar y validar el ciclo real de órdenes V2, deduplicación por client_order_id, conciliación de ejecuciones parciales, saldo, comisiones y posiciones tras reinicio. API vigente: https://docs.kalshi.com/api-reference/orders/create-order-v2
- Resolver cada contrato contra su fuente oficial y ampliar el catálogo con un mapeo verificado de activos, series e intervalos. Los mercados no financieros requieren modelos distintos.
- Validar en el entorno de prueba de Kalshi y medir calibración antes de habilitar dinero real.
- Instalar supervisión y arranque automático del servicio. El proceso actual necesita que Windows permanezca encendido, conectado y sin suspensión; no se ha configurado inicio al arrancar ni recuperación automática.

Guardar límites no habilita dinero real. Un objetivo de pérdida no debe confundirse con una garantía de rentabilidad o de ejecución a un precio determinado.

Verificación: 523 pruebas, 522 correctas, 1 omitida, 0 fallos; arrastre y redimensionado comprobados en navegador; guardado del formulario confirmado y escritura desde otro origen rechazada con HTTP 403.
