# Pronóstico y referencia de precios

El motor local es TimesFM 2.5, 200 millones de parámetros, pesos Apache-2.0.
TimesFM 3.0 no se activa: sus pesos publicados restringen el uso en producción.
No usa OpenAI ni envía las series a un servicio de IA externo.

## Instalación Windows

```powershell
py -3.13 -m venv .venv-forecast
.\.venv-forecast\Scripts\python.exe -m pip install -r forecast/requirements.txt
.\.venv-forecast\Scripts\python.exe forecast/worker.py --prepare
npm start
```

El servidor inicia el proceso de inferencia al recibir la primera consulta.
Los pesos se descargan una vez en data/models, excluido de Git. La primera inferencia carga el modelo en RAM; no requiere GPU.

## Qué se pronostica

Un cierre por consulta: el bloque actual del activo y temporalidad elegidos.
Usa hasta 256 cierres anteriores. La vela en formación NO entra en el entrenamiento ni en la validación.
El pronóstico se fija a partir del último cierre; no asimila movimientos intravela. Se actualiza al disponer de una nueva vela cerrada.
La mediana indica el cierre estimado. Los percentiles 10 y 90 forman un rango central nominal del 80%, no una garantía de cobertura.
La dirección se marca «sin ventaja clara» mientras la validación no alcance 100 casos y supere al precio anterior con un acierto direccional mayor al 55%. La validación breve actual de 24 casos no alcanza ese umbral. Se publica el cierre estimado experimental, sin convertirlo en una señal para operar.
La validación usa 24 orígenes históricos sucesivos sin incluir el objetivo en cada entrada. Muestra MAE, MAE del último precio y cobertura observada. Es una muestra pequeña, no una prueba de rentabilidad.
Las criptos usan velas consolidadas USD cuando están disponibles, con fallback identificado Binance/USDT; las acciones usan el feed Alpaca configurado. Fuera de sesión, con reloj desconocido, historial insuficiente, huecos o sin vela actual, se abstiene. Los huecos nocturnos limitan la cobertura de acciones intradía. El demo se etiqueta explícitamente.

El botón «Calcular estimación» consulta `/api/neural-forecast`. Los escenarios estadísticos usan un motor separado EWMA con calibración conforme evaluada en avance temporal. No sustituir la nota de un motor por la del otro.

## Kalshi

El consolidado de exchanges es una mediana USD; no es un valor oficial de Kalshi.
La tarjeta separada obtiene CF Benchmarks vía la API autenticada de Kalshi.
Configurar en .env KALSHI_API_KEY_ID y KALSHI_PRIVATE_KEY_PATH (archivo PEM local). No subir secretos a Git.
La cuenta necesita acceso al passthrough. Sin credenciales, permisos o un dato reciente, no se sustituye el índice por un precio aproximado.
Los contratos cripto pueden liquidar con el promedio de los 60 segundos finales según sus reglas: el valor instantáneo mostrado no es ese promedio.
El modelo de velas NO predice el promedio de liquidación de un contrato Kalshi. Para ello faltan el contrato exacto y el historial de su índice.

Fuentes: https://docs.kalshi.com/cfbenchmarks/rest-passthrough · https://help.kalshi.com/en/articles/13823838-crypto-markets · https://github.com/google-research/timesfm · https://huggingface.co/google/timesfm-2.5-200m-pytorch

## 2026-10-04 — Laboratorio TimesFM de un minuto
Se añadió src/timesfm-minute-lab.js al recolector existente, con un turno por minuto alternando BTC y ETH. Consume sólo velas cerradas de 1 minuto con procedencia Coinbase+Kraken, ambas USD nativo; no convierte retrospectivamente USDT. Conserva primeras observaciones de cierres, exige continuidad y precios recientes y acumula hasta 4096 minutos por activo. Activa contextos 256/512/1024 sólo cuando existen, sin relleno. Predice hasta el próximo cierre de 15m; no es liquidación de Kalshi.
Las entradas, sus hashes, versión de implementación, paquete, horizonte y cuantiles quedan congelados antes del resultado. Los errores y cobertura del intervalo se calculan por activo, horizonte exacto, conjunto de ventanas y versión. No mezclar estos resultados con la serie de cuatro proveedores del modelo anterior. Progreso de la IA muestra el laboratorio y sus comparaciones. Las predicciones tardías se descartan.
worker_shared.py reutiliza las definiciones del worker anterior y una sola instancia del modelo; cambia temporalmente el contexto y restaura la configuración anterior. El candidato realiza sólo inferencia en vivo, sin las 24 validaciones históricas por consulta; el control conserva su comportamiento. No se afirma todavía una reducción medida de latencia ni de error. El cambio del archivo forecast-neural.js cambia la huella de integración existente: los grupos originales permanecen separados.
Preparación LoRA: node scripts/prepare-timesfm-lora.js exporta entradas crudas y etiquetas de minutos posteriores ya cerrados con separación temporal y embargo. No instala ni entrena; actualmente insufficient-data. No usar futuros valores de mercado como covariables conocidas. XReg financiero y objetivo exacto BRTI quedan pendientes de datos adecuados y validación; no se inventan promedios de liquidación.
Pruebas: suite completa 676 aprobadas, 1 omitida, 0 fallos antes del ajuste de lectura incremental; 9 pruebas de laboratorio/exportación/integración y 5 de lectura/piloto aprobadas después. Se corrigió carga de events.jsonl para leer incrementalmente sin duplicar un archivo de 203 MB en memoria. Sin cambios a riesgo, credenciales u órdenes; automatización demo PAUSED.
Referencias oficiales consultadas: https://github.com/google-research/timesfm/blob/master/timesfm-forecasting/references/api_reference.md y https://github.com/google-research/timesfm/blob/master/timesfm-forecasting/examples/finetuning/README.md . Mantener TimesFM 2.5; no activar 3.0 descargado para producción.

Verificación conectada 2026-10-04: /api/neural-forecast devolvió ok=true para BTC15m a través del worker compartido. El laboratorio guardó su primera predicción real: BTCUSDT, contexto 256, horizonte 12 minutos, 353 velas disponibles, 472 ms de inferencia con modelo caliente, entrada cerrada a 1791151380000 y emisión a 1791151389363, antes del objetivo 1791152100000. Sólo una medición de latencia, no benchmark general. Colector sin errores en esa ronda. Pendiente resultado del cierre; sin superioridad demostrada. Ventanas 512/1024 esperan datos continuos suficientes. Servidor PID14164.
