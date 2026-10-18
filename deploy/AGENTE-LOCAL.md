# Agente local con OpenAI

La aplicación permanece en http://localhost:3000. Las consultas del agente salen a la API de OpenAI; no se publica la aplicación.

Guarda OPENAI_API_KEY en .env, excluido de Git. Al encontrarla, el agente usa OpenAI. OPENAI_AGENT_MODEL permite elegir el modelo (predeterminado: gpt-5.5); OPENAI_AGENT_EFFORT controla el esfuerzo (predeterminado: low). AGENTE_PROVEEDOR permite seleccionar explícitamente openai o anthropic. Reinicia el servidor tras cambiar la configuración.

El agente lee reglamentos y puede vetar operaciones simuladas. No coloca órdenes ni genera los pronósticos de TimesFM. La consulta de noticias exige búsqueda web completada; los errores bloquean al bot. Las fichas extraídas requieren aprobación humana antes de utilizarse.

Para iniciar el bot simulado con revisión de contexto:

    npm run agente -- --agente --web

Las consultas usan la cuenta de API y pueden consumir saldo. Se cachea el contexto hasta 15 minutos, limitado por la caducidad de los vetos.

## Controles desde la app

Bot y riesgo → Capital y límites incluye Iniciar/Detener bot y Activar/Desactivar agente. El agente de contexto funciona dentro del proceso del bot; habilitarlo con el bot detenido lo deja a la espera. No controla el aprendizaje neuronal ni la revisión de Codex. Las preferencias persisten en datos/bot-control.json. Detener solicita terminar el ciclo y bloquea nuevas entradas; no liquida posiciones ni sigue supervisándolas. La pausa de entradas mantiene las salidas. Una consulta de contexto en curso puede terminar después de desactivarlo. El proceso usa un bloqueo exclusivo para evitar duplicados y restaura la cartera del registro. El inicio desde la app usa solo simulación, con búsqueda de contexto habilitada. Los botones no activan dinero real ni cambian límites.
