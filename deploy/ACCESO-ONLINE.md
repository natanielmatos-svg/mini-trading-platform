# Acceso privado desde Internet

Preparado para trading.maroautogroup.com con Cloudflare Tunnel y Access. Sigue ejecutándose en esta laptop: requiere equipo encendido, red, servidor 3000 y pasarela 3002. No cambia ejecución financiera ni sus límites.

Antes de publicar: crear aplicación Access self-hosted para el hostname completo, permitir únicamente el correo del propietario con PIN por email y sesión limitada. No usar políticas Bypass/Everyone. Configurar CF_ACCESS_ISSUER (https://equipo.cloudflareaccess.com), CF_ACCESS_AUD y TRADING_ALLOWED_EMAILS en entorno privado. TRADING_PUBLIC_ORIGIN=https://trading.maroautogroup.com.

Ejecutar node scripts/remote-access.js. La pasarela escucha sólo en loopback, valida firma JWT RS256, emisor, destinatario, caducidad y correo; bloquea POST sin origen HTTPS exacto. Sólo después de autenticar adapta Host/Origin para las rutas locales existentes. El túnel debe apuntar a 3002, nunca directamente a 3000. Mantener el bind de 3000 en 127.0.0.1.

Crear un túnel independiente usando deploy/trading-tunnel.example.yml para no interrumpir MaroAutoGroup. Crear DNS sólo después de configurar Access. Verificar rechazo anónimo desde Internet y login del propietario, cuenta, controles, precios SSE y TimesFM. La inferencia fría puede superar los límites del proxy: revisar antes de declarar toda la funcionalidad remota verificada.

Estado: correo autorizado guardado en el entorno local. Dominio y aplicación Access pendientes de iniciar sesión administrativa en Cloudflare. No publicado todavía.

Referencia: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/

## Estado 2026-09-28
Aplicación Access creada: 1a30538b-3bbc-41ca-b142-e3d8f8520565. Política Usuarios autorizados trading para los dos correos solicitados, sesión 6 horas. Método de entrada observado: Cloudflare (no PIN por correo). DNS trading.maroautogroup.com apunta al túnel independiente ecd92559-6560-4a70-baa2-8347052f8d07; configuración C:\Users\natan\.cloudflared\trading.yml. Entorno local configurado con emisor, AUD y ambos correos. Verificado HTTP 302 anónimo a Access y pantalla de login. El arranque de pasarela 3002 y túnel fue rechazado por revisión automática: blocked by policy. No se ha verificado acceso autenticado al backend; despliegue incompleto hasta arrancar ambos procesos. No se modificó el bot ni el riesgo.

Actualización 23:39 UTC: usuario arrancó procesos. Confirmado 3000/healthz HTTP 200, pasarela 3002 HTTP 403 sin JWT, ambos sólo loopback; túnel con cuatro conexiones activas. Login público funciona y redirige a Cloudflare. Pendiente completar inicio de sesión de usuario y verificar backend autenticado; no afirmar aún validación integral.
Prueba Chrome después de autenticación: ERR_BLOCKED_BY_CLIENT, persiste una recarga. No se alteraron protecciones del navegador. Conectividad de túnel/pasarela confirmada; vista autenticada no verificada.

Corrección de retorno Access: se permite GET / como navegación superior (navigate/document) desde otro sitio, siempre con JWT válido y correo autorizado. Se mantienen bloqueados POST, APIs, iframe, fetch externo y Origin ajeno. Cuatro pruebas pasan, incluida integración con JWT firmado y servidor de prueba. Pendiente reinicio manual de la pasarela 3002 para cargar el cambio; el proceso existente conserva la versión anterior.
