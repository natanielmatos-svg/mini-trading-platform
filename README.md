# Mini Trading Platform + Analizador de Mercados de Predicción

Dos aplicaciones sobre el mismo servidor Node/Express:

| Ruta | Qué es |
|---|---|
| `/index.html` | **Plataforma de trading**: velas de Binance en vivo, tendencia multi-timeframe con EMAs, análisis de ruptura de la vela en curso y avisos de compra y venta con sonido |
| `/predicciones.html` | **Analizador de predicciones**: agrega Polymarket, Robinhood/Kalshi y Manifold y dice qué opción es la más probable de cada evento |

## Arranque

```bash
npm install
npm start            # http://localhost:3000
npm run demo         # datos de ejemplo, sin salida a Internet (también el gráfico)
npm test             # 165 tests, sin red
npm run smoke        # valida las APIs reales (obligatorio antes de desplegar)
npm run static -- salida.html --demo   # instantánea estática autocontenida
```

Ningún script usa sintaxis de shell, así que funcionan igual en Linux, macOS y
Windows (PowerShell incluido). Hace falta Node 20 o superior: `node -v`.

### Cómo se prueba

```bash
npm test          # 165 tests, sin red, en unos cinco segundos
npm run smoke     # llama a las APIs de verdad — la única prueba que las valida
```

Los tests cubren tres capas, y conviene saber qué prueba cada una:

| Qué | Cómo | Qué garantiza |
|---|---|---|
| Indicadores, ruptura, señales | Series sintéticas con pivotes controlados | Que las reglas hacen lo que dicen |
| Rutas HTTP, caché, límites | El servidor en un puerto efímero, modo demo | Que la API se comporta |
| **Protocolo de Binance** | Un servidor local que imita su REST y su WebSocket (`test/binance.test.js`, `test/stream-binance.test.js`) | Que si Binance responde lo que documenta, se entiende; y que sus errores —400, 429, 503, formato cambiado, socket caído— no tumban nada |

En Node 20 se saltan los ocho tests del WebSocket: esa versión no trae
`WebSocket` global, el hub lo detecta y usa sondeo, y eso último sí se prueba.

Lo que ningún test puede garantizar es que Binance **siga** respondiendo lo que
documenta: son APIs públicas sin contrato de estabilidad. Para eso está
`npm run smoke`, que llama a las de verdad y sale con código 1 si alguna falla.
Córrelo antes del primer arranque y después de cada actualización.

## La plataforma de trading

Velas de Binance, EMAs sobre el gráfico, tendencia en cuatro timeframes y un
panel que responde a una sola pregunta: **¿esta vela va a romper, y hacia
dónde?**

### Precio en vivo

El navegador no habla con Binance. Abre una conexión SSE a `/api/stream` y el
servidor mantiene **un solo WebSocket por símbolo y timeframe**, compartido
entre todos los clientes: cien pestañas abiertas siguen siendo una conexión
saliente. Si el WebSocket no levanta —Node antiguo, red que lo bloquea— tras
tres intentos se degrada a sondeo periódico sobre la caché y se avisa en la
interfaz; cinco minutos después se vuelve a intentar el WebSocket.

Las velas históricas vienen de `/api/klines`, que las cachea entre 5 y 60
segundos según el timeframe y agrupa las peticiones simultáneas en una sola
llamada saliente.

### ¿Rompe esta vela? El método

La respuesta honesta a "¿va a romper?" no es un oráculo, es **una frecuencia
observada**. Tres pasos, todos comprobables a mano:

1. **Localizar el nivel.** No cualquier precio: los pivotes donde el mercado ya
   se dio la vuelta (una vela cuyo máximo supera al de las tres de cada lado),
   agrupados cuando están tan juntos que son el mismo nivel tocado varias veces.
   El número de toques es la fuerza del nivel. Si no hay pivote por delante
   —un activo en subida libre— se usa el extremo de las últimas 60 velas y se
   marca como tal.

2. **Medir la distancia en ATR, no en dólares.** "Faltan 300 $" no dice nada;
   "falta 0,4 ATR" dice que es un recorrido corriente para este activo y este
   timeframe.

3. **Contar cuántas velas anteriores hicieron ese recorrido.** De las ~385
   velas cargadas, ¿cuántas se movieron desde su apertura al menos lo que ahora
   falta? Ese porcentaje es la probabilidad que se muestra. No hay modelo
   escondido detrás: es una cuenta sobre el histórico que tienes delante.

**El ajuste por tiempo.** A una vela a la que le queda el 30% de su vida no se
le puede exigir el recorrido de una vela entera. Como la volatilidad de un
recorrido escala con la raíz del tiempo, la distancia pendiente se compara
contra la muestra dividida por `sqrt(fracción restante)`: a media vela el listón
sube un 41%, y en el último minuto se dispara. Por eso cuando queda poco se
muestra también **cuánto sería con una vela entera por delante**, que es la
pregunta útil en ese momento.

El navegador recalcula ese número con cada tick usando exactamente las mismas
dos funciones que el servidor (`requiredExcursion` y `shareAtLeast`) sobre la
muestra que vino en la respuesta, así que lo que se ve en vivo es lo que
devolvería `/api/breakout` si se le preguntara en ese instante.

### Lo que la probabilidad no incluye

El contexto va aparte, y a propósito: son las señales que explican si una
ruptura tendría continuidad, pero meterlas en el número sería inventarse una
ponderación.

| Señal | Qué dice |
|---|---|
| Compresión del ATR frente a su media de 50 | Los rangos estrechos preceden a los movimientos amplios |
| Posición dentro del rango de 50 velas | Pegado al techo es donde nacen las rupturas y las trampas |
| Volumen proyectado de la vela en curso | Sin volumen, una ruptura se recupera |
| EMA rápida contra lenta | Contra qué corriente iría la ruptura |
| RSI(14) | Agotamiento, no señal por sí solo |
| Forma de la vela (cuerpo y mechas) | Una mecha superior larga es alguien vendiendo cada intento |

Y la confirmación se separa del pronóstico: **un cierre** por encima del nivel
con volumen por encima de 1,3× la media. Un pico que toca el nivel y vuelve
dentro antes del cierre es un rechazo, no una ruptura.

### Cuándo comprar y cuándo vender

El panel de ruptura dice qué es probable; los avisos dicen **qué hacer**, y
suenan aunque estés en otra pestaña. Se encienden con el interruptor de la
tarjeta correspondiente, que pide permiso de notificaciones y desbloquea el
sonido. El botón *Probar* lanza una alerta de mentira para comprobar que
sonido y permisos funcionan antes de fiarte de ellos.

| Aviso | Cuándo salta | Sonido |
|---|---|---|
| **COMPRAR** | Una vela **cierra** por encima de la resistencia con al menos 1,3× el volumen medio | Dos notas ascendentes |
| **VENDER** | Stop, objetivo, ruptura falsa o señal contraria sobre lo comprado | Dos notas descendentes |
| **Señal de venta** | Una vela cierra por debajo del soporte sin que haya nada comprado | Dos notas descendentes |
| **Aviso previo** | La probabilidad de romper pasa del 70% y la vela sigue abierta. **Apagado por defecto** | Dos notas iguales |

La regla que lo gobierna todo es la misma que ya definía el análisis: **una
ruptura sólo cuenta si la vela cierra al otro lado del nivel y con volumen**.
Un pico que toca el nivel y vuelve dentro es un rechazo, y comprar ahí es la
forma más habitual de perder dinero con este tipo de sistema. Por eso el aviso
previo existe pero está separado de la compra, y dice explícitamente que
todavía no lo es.

Al confirmarse una compra se abre un **seguimiento en papel** con el precio de
compra, el stop —bajo el mínimo de la vela que rompió, más un margen de 0,1
ATR— y el objetivo: **el primer nivel por delante que esté al menos a 1,5 veces
el riesgo**, o el doble del riesgo si ninguno llega. Ese mínimo no es un
adorno: coger el nivel más cercano sin más daba, medido sobre histórico, un
89% de compras con ratio por debajo de 1:1 y una mediana de 0,52 —alguna de
0,02, que es arriesgar cincuenta para ganar uno—. Con eso se acierta dos de
cada tres veces y se pierde dinero igual, que es exactamente lo que salía. Ambos se dibujan en el gráfico, y el aviso dice literalmente
cuándo vender: *«vender si baja de 109,68 o al llegar a 125,65»*. El
seguimiento se cierra solo cuando llega ese momento:

- **Stop**: el precio cae por debajo del stop. Se vende para no seguir perdiendo.
- **Objetivo**: el precio alcanza el nivel fijado al comprar.
- **Ruptura falsa**: una vela posterior cierra de vuelta por debajo del nivel
  roto. Es la trampa clásica: se vende sin esperar al stop.
- **Señal contraria**: se confirma una ruptura bajista con la compra abierta.

#### Las dos operativas

En contado no se puede vender lo que no se tiene, así que una ruptura bajista
con la cartera vacía no es una operación. El desplegable *Operativa* decide qué
hacer con ella:

- **Contado: comprar y vender** (por defecto). La bajada no abre nada, pero
  tampoco se calla: avisa como señal de venta para quien ya tenga la moneda y
  de quedarse fuera para quien no.
- **Contado y corto**. Además sigue las bajadas: *vender en corto* para abrir y
  *recomprar* para cerrar, con el mismo stop y objetivo que en el otro sentido.

El aviso previo viene apagado a propósito. Medido sobre histórico real de
BTCUSDT en velas de 1h, salta unas **2-3 veces al día**: útil si quieres
vigilar la aproximación a un nivel, ruido si sólo quieres saber cuándo comprar
y cuándo vender. Se enciende con su casilla. Un mismo nivel avisa una vez por
aproximación y no una vez por vela — con el identificador atado a la vela eran
144 avisos en 320 velas, un popup con sonido cada dos horas.

Detalles que conviene saber:

- **No manda ninguna orden a ningún sitio.** Es un seguimiento en papel: no
  sabe cuánto dinero tienes ni habla con ningún bróker.
- **Los avisos son del par que tienes abierto.** No vigila las veintinueve
  criptos a la vez: eso serían veintinueve conexiones y otros tantos análisis.
- **Al abrir la página no suena nada.** La primera evaluación sólo toma nota:
  gritar por una señal que ocurrió mientras el navegador estaba cerrado es
  ruido. Esas señales aparecen en el historial marcadas como anteriores.
- **Una señal no se repite**, aunque se evalúe cien veces: cada una lleva un
  identificador derivado de la vela que la produjo.
- El seguimiento sobrevive a recargas (`localStorage`), y si el navegador no
  deja guardar —modo privado— todo sigue funcionando, sólo se olvida.

### Criptomonedas

El desplegable trae los pares contra USDT que alguien querría mirar, agrupados
por tipo, y una opción *Otro par…* para escribir cualquier otro. La lista vive
en `src/symbols.js`; cuando hay red se contrasta con Binance y los pares que
hayan dejado de cotizar no se ofrecen. Si Binance no responde, se sirve sin
verificar antes que dejar el desplegable vacío.

### Límites del método

- La muestra es **incondicional**: no sabe si la vela ya gastó su empuje. Una
  vela que lleva media hora subiendo y otra que lleva media hora parada reciben
  el mismo tratamiento.
- El ATR con el que se normaliza cada vela histórica es **el previo a esa vela**,
  nunca el posterior; si no, el cálculo miraría el futuro y saldrían números
  preciosos e inútiles.
- Los avisos de compra y venta heredan todos estos límites: son reglas
  mecánicas sobre el histórico, no una lectura del mercado. No tienen en cuenta
  noticias, ni el libro de órdenes, ni las comisiones, ni el deslizamiento, y
  decir "comprar" es describir lo que hace la regla, no aconsejarte a ti.
- Frecuencia histórica no es probabilidad futura. Es análisis de mercado, no una
  recomendación de inversión.

## Qué hace el analizador

Para cada evento (unas elecciones, una decisión de la Fed, un partido) descarga
lo que cotiza cada plataforma, empareja los mercados equivalentes aunque estén
redactados distinto, y devuelve **una sola respuesta**: qué opción es la más
probable, con qué probabilidad y con cuánta confianza.

### Plataformas

| Fuente | API | Credibilidad |
|---|---|---|
| Polymarket | Gamma API (`gamma-api.polymarket.com`) | 1.0 |
| Robinhood / Kalshi | Kalshi Trade API v2 | 1.0 |
| Manifold | API v0 | 0.35 |

Los contratos de evento de **Robinhood** se listan en la bolsa **Kalshi**:
Robinhood es el bróker, pero el libro de órdenes y el precio son los de Kalshi.
Por eso una sola fuente cubre ambas plataformas. Manifold usa dinero de juego,
así que su cotización cuenta como tercera opinión pero pesa mucho menos.

Añadir una plataforma es escribir un módulo en `src/providers/` que exporte
`meta` y `fetchEvents()` devolviendo eventos en la forma canónica descrita en
`src/providers/base.js`, y registrarlo en `src/providers/index.js`.

### El método, paso a paso

1. **Precio → probabilidad.** Se usa el punto medio del libro `(bid+ask)/2`, no
   el último operado, que puede llevar horas parado. Kalshi cotiza en dólares por
   contrato (y antes en centavos: se aceptan ambos formatos) y Polymarket en
   dólares: todo se lleva a 0..1. Si una plataforma
   sólo publica la pata "Sí", la pata "No" se deriva por complemento.

2. **Quitar el vig.** Los precios "Sí" de un evento donde sólo puede ganar una
   opción suelen sumar más de 1: ese exceso es el margen del creador de mercado.
   Dividir por la suma devuelve probabilidades que suman 100%. El exceso se
   reporta como `overround` para que se vea de dónde salió.

3. **Emparejar eventos entre plataformas.** Nadie escribe la misma pregunta
   igual ("Presidential Election Winner 2028" vs "Who will win the 2028
   presidential election?"). Se comparan títulos y conjuntos de opciones con
   coeficiente de Dice sobre tokens normalizados (sin acentos, sin stopwords) y
   se exige que las fechas de cierre sean compatibles. Entre dos mercados Sí/No
   decide sólo el título: sus opciones son idénticas por construcción y esa
   señal no distingue nada. Y si ambos títulos citan años y no comparten
   ninguno, se descartan de plano: en un mercado de predicción el año es el
   contrato. Cada plataforma aporta
   como mucho un mercado por grupo.

4. **Consenso ponderado en espacio logit.** La media se calcula sobre
   `log(p/(1-p))`, no sobre `p`: la media aritmética distorsiona los extremos
   (entre 1% y 10% la diferencia real es de casi 10x, no de 9 puntos). El peso
   de cada plataforma es:

   ```
   peso = credibilidad × (0.5 + log(1 + liquidez + 0.25·volumen)) × 1/(1 + 10·spread)
   ```

   Un mercado profundo y con spread estrecho manda sobre uno fino y ancho.

5. **Ranking y veredicto.** Las probabilidades del consenso se vuelven a
   normalizar si el evento es excluyente, se ordenan de mayor a menor y la
   primera es la respuesta. Se acompaña de:
   - **margen** sobre la segunda opción (si es < 5 pts, se avisa de que el
     favorito no es fiable),
   - **confianza** (0..1) a partir de profundidad, número de plataformas y
     acuerdo entre ellas,
   - **divergencia**: cuánto discrepan las plataformas en la opción ganadora,
   - **mejor precio de compra** y el *edge* frente al consenso,
   - **arbitraje**: si comprar todas las opciones del evento cuesta menos de
     100¢ y una de ellas paga 100¢ seguro.

### Límites conocidos

- El emparejamiento por similitud de texto es heurístico: eventos parecidos pero
  con reglas de resolución distintas ("cerrar por encima de X **el 31 de dic**"
  vs "**en algún momento** de diciembre") pueden agruparse por error. Por eso
  cada evento expone sus fuentes con enlace, para verificar la letra pequeña.
- El *edge* y el arbitraje se calculan sobre el mejor precio publicado, sin
  contar comisiones ni el tamaño disponible a ese precio.
- Las opciones "Other" y equivalentes se muestran y cuentan para el reparto de
  probabilidad, pero nunca encabezan el veredicto: responder "lo más probable es
  Otro" no contesta la pregunta. Si ese cajón supera al favorito se avisa, porque
  entonces el mercado está apuntando a alguien fuera de la lista.
- Cada plataforma enumera candidatos distintos: donde una lista cincuenta
  nombres, otra lista cuarenta y un "Other". El universo de opciones lo fija la
  fuente más profunda del grupo, y las demás sólo afinan el precio de las que ya
  están; lo que sólo cotiza una plataforma secundaria se descarta. Sin esa regla
  la masa de probabilidad de cada cola se contaba dos veces y todos los
  porcentajes bajaban alrededor de un 30%.
- Manifold usa dinero de juego: informa, pero no debe mover una decisión.
- Es análisis de mercado, no una recomendación de inversión.

## API

Todas las rutas aceptan `?demo=1` para responder con datos de ejemplo.

### `GET /api/predictions`

Análisis completo. Parámetros: `q` (búsqueda), `platforms`
(`polymarket,robinhood_kalshi,manifold`), `limit`, `minLiquidity`, `threshold`
(umbral de emparejamiento, 0..1). Cuántos eventos se piden a cada plataforma no
es un parámetro de la petición — ver *Exposición pública* más abajo.

```jsonc
{
  "generatedAt": "2026-08-13T05:20:00.000Z",
  "sources": [{ "platform": "polymarket", "ok": true, "events": 60, "elapsedMs": 412 }],
  "counts": { "rawEvents": 180, "analyzedEvents": 25, "crossPlatformEvents": 9 },
  "events": [{
    "title": "Presidential Election Winner 2028",
    "mostLikely": { "label": "Gavin Newsom", "probability": 0.434, "margin": 0.055 },
    "options": [{ "label": "Gavin Newsom", "probability": 0.434, "platformCount": 3,
                  "range": { "min": 0.424, "max": 0.46 }, "divergence": 0.036,
                  "bestPrice": { "platformLabel": "Robinhood / Kalshi", "ask": 0.45, "edge": -0.016 },
                  "platforms": [/* cotización de cada plataforma */] }],
    "confidence": 0.83,
    "verdict": { "text": "\"Gavin Newsom\" es la opción más probable con 43.4% …", "confidenceLabel": "alta" },
    "flags": [], "arbitrage": null, "sources": [/* enlaces a cada mercado */]
  }]
}
```

### `GET /api/predictions/best?q=...`

Respuesta directa: sólo el evento que mejor casa con la búsqueda y su opción
ganadora. Pensado para consumir desde otra app o desde `curl`.

### `GET /api/predictions/sources`

Plataformas soportadas y su credibilidad asignada.

### `GET /api/klines`

Velas OHLCV cacheadas. Parámetros: `symbol`, `interval` (lista blanca de 15
timeframes), `limit` (tope: `KLINES_FETCH_LIMIT`), `format=raw` para el array
posicional de Binance de la versión anterior.

```jsonc
{
  "symbol": "BTCUSDT", "interval": "1h", "source": "binance",
  "fetchedAt": 1790000000000, "count": 300,
  "candles": [{ "openTime": 1789999200000, "open": 64010.1, "high": 64320.0,
                "low": 63980.2, "close": 64180.5, "volume": 812.4,
                "closeTime": 1790002799999, "closed": true }]
}
```

Ya no es un proxy transparente: cuántas velas se piden a Binance es una
constante del servidor, no el `limit` del cliente. Si el cliente fijara el
tamaño, cada valor sería una clave de caché distinta y bastaría recorrerlos para
multiplicar las llamadas salientes — el mismo razonamiento que en el analizador.

### `GET /api/breakout`

Análisis de ruptura de la vela en curso. Parámetros: `symbol`, `interval`,
`price` (precio en vivo del cliente, opcional).

```jsonc
{
  "ok": true, "price": 64180.5, "atr": 310.2, "atrPct": 0.483,
  "candle": { "openTime": 1790000000000, "closeTime": 1790003599999,
              "elapsed": 0.42, "remainingMs": 2088000, "remainingLabel": "34 min" },
  "up":   { "level": 64320, "touches": 3, "distancePct": 0.217, "distanceAtr": 0.45,
            "requiredAtr": 0.59, "probability": 0.283, "probabilityFullCandle": 0.372,
            "sampleSize": 385 },
  "down": { "level": 63900, "touches": 5, "probability": 0.41, "…": "…" },
  "bias": "baja",
  "context": [{ "key": "compresion", "label": "Volatilidad", "lean": "neutral", "text": "…" }],
  "explanation": ["Vela de 1h en curso: abrió en …", "Para romper al alza faltan …"],
  "trigger": { "up": { "text": "Ruptura alcista válida: cierre de 1h por encima de …" } },
  "sample": { "up": [0.4, 1.2, …], "down": […], "remainingFraction": 0.58 },
  "disclaimer": "Frecuencia histórica de recorridos, no una predicción …"
}
```

### `GET /api/symbols`

Catálogo de criptomonedas para el desplegable, agrupado. `verified` dice si se
pudo contrastar con Binance.

```jsonc
{
  "verified": true, "count": 29,
  "groups": [{ "name": "Principales",
               "symbols": [{ "symbol": "BTCUSDT", "name": "Bitcoin", "available": true }] }]
}
```

### `GET /api/stream`

Precio en vivo por SSE. Parámetros: `symbol`, `interval`. Emite eventos `kline`
(cada actualización de la vela en curso) y `status` (estado del upstream), más
un comentario de latido cada 20 s para que ningún proxy corte la conexión.

```
event: kline
data: {"symbol":"BTCUSDT","interval":"1h","source":"ws","close":64180.5,"closed":false,…}
```

## Despliegue en un VPS

La app no guarda estado: es un proceso Node que consulta APIs públicas y cachea
en memoria. No hay base de datos ni volúmenes que respaldar, así que desplegar
es copiar el código y reiniciar el proceso.

### 1. Antes de exponer nada: comprobar las fuentes

```bash
npm ci
npm run smoke
```

Llama a las APIs reales —Binance y las tres plataformas de predicción— y
verifica que sus respuestas se siguen pudiendo parsear y analizar. Sale con código 1 si alguna falla, así que
sirve como puerta en un script de despliegue. **Córrelo antes del primer
arranque y después de cada actualización**: las tres son APIs públicas sin
contrato de estabilidad y pueden cambiar un campo sin avisar.

Con `--tolerante` sólo falla si caen todas, que es el criterio razonable para un
reinicio automático — el agregador funciona con las fuentes que respondan.

### 2a. Con Docker (recomendado)

```bash
docker compose up -d --build
docker compose logs -f
curl localhost:3000/healthz
```

El contenedor sólo escucha en `127.0.0.1`: quien da la cara a Internet es Nginx.

### 2b. Sin Docker, con systemd

```bash
sudo useradd --system --home /opt/mini-trading-platform mtp
sudo git clone https://github.com/natanielmatos-svg/mini-trading-platform /opt/mini-trading-platform
cd /opt/mini-trading-platform && sudo npm ci --omit=dev
sudo chown -R mtp:mtp /opt/mini-trading-platform

sudo cp deploy/mini-trading-platform.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mini-trading-platform
sudo systemctl status mini-trading-platform
```

La unidad corre como usuario sin privilegios, con el directorio en sólo lectura
y `ProtectSystem=strict`. La app no escribe nada en disco, así que no le hace
falta más.

La configuración de Nginx incluye un bloque específico para `/api/stream` con
el búfer desactivado: SSE es una respuesta que no termina nunca y un stream
bufferizado no llega jamás al navegador.

### 3. Nginx y TLS

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/mini-trading-platform
# edita el archivo y sustituye TU-DOMINIO.com
sudo ln -s /etc/nginx/sites-available/mini-trading-platform /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d TU-DOMINIO.com
```

### 4. Actualizar

```bash
cd /opt/mini-trading-platform
git pull && npm ci --omit=dev
npm run smoke                                  # valida antes de reiniciar
sudo systemctl restart mini-trading-platform   # o: docker compose up -d --build
```

El proceso cierra ordenadamente con SIGTERM: deja terminar las peticiones en
vuelo antes de salir, hasta 10 segundos.

### Qué vigilar

- **`GET /healthz`** — sonda de vida. No llama a ninguna API externa a
  propósito: si lo hiciera, una caída de Polymarket provocaría reinicios en
  cadena de un servicio que está perfectamente sano.
- **El campo `sources[]` de `/api/predictions`** — ahí se ve si una plataforma
  dejó de responder o cambió de formato, sin tumbar el resto del análisis. Es la
  señal que conviene alertar, no el healthcheck.
- **Logs** — `journalctl -u mini-trading-platform -f` o `docker compose logs -f`.
- **`streams` en `/healthz`** — cuántas salas de precio en vivo hay abiertas y
  con qué fuente. Un `source: "poll"` permanente significa que el WebSocket de
  Binance no levanta desde este servidor.

### Exposición pública

Al abrirlo a Internet hay dos cosas que el servidor ya controla:

- **Límite de peticiones por IP** (120 por minuto por defecto, `RATE_MAX` y
  `RATE_WINDOW_MS`). No frena un ataque serio — para eso está el proxy — pero
  evita que el bucle descontrolado del navegador de alguien agote los rate
  limits de las APIs ajenas, que son compartidos por todos tus usuarios.
- **Cuántos eventos se piden a cada plataforma** es una constante del servidor
  (`PREDICTIONS_FETCH_LIMIT`), no un parámetro de la petición. Si el cliente
  pudiera elegirlo, cada valor sería una clave de caché distinta y bastaría
  recorrerlos para multiplicar por doscientas las llamadas salientes.

La app no tiene autenticación ni la necesita: todo lo que sirve son datos
públicos de mercado, y no acepta ninguna escritura.

## Configuración

| Variable | Por defecto | Para qué |
|---|---|---|
| `PORT` | `3000` | Puerto del servidor |
| `DEMO` | — | `DEMO=1` fuerza datos de ejemplo en todas las respuestas |
| `PREDICTIONS_TTL_MS` | `30000` | Caché de los datos de mercado |
| `POLYMARKET_API` / `KALSHI_API` / `MANIFOLD_API` | APIs públicas | Para apuntar a un mirror o a un mock |
| `PREDICTIONS_FETCH_LIMIT` | `120` | Eventos pedidos a cada plataforma por ciclo |
| `KLINES_FETCH_LIMIT` | `500` | Velas pedidas a Binance por ciclo (y tope del `limit` del cliente) |
| `MAX_STREAMS_PER_IP` | `6` | Conexiones de precio en vivo simultáneas por IP |
| `BINANCE_API` / `BINANCE_WS` | APIs públicas | Para apuntar a un mirror o a un mock |
| `RATE_MAX` / `RATE_WINDOW_MS` | `120` / `60000` | Límite de peticiones por IP a `/api` |
| `TRUST_PROXY_HOPS` | `1` | Saltos de proxy de confianza para leer la IP real |

Ninguna API necesita clave: se usan sólo endpoints públicos de lectura. Las
respuestas se cachean 30 s y las peticiones simultáneas a la misma clave se
agrupan en una sola llamada, para no chocar con los rate limits.

## Estructura

```
server.js              rutas HTTP
src/
  indicators.js        EMA, ATR, RSI, pivotes, niveles — servidor Y navegador
  format.js            formato de precios y porcentajes — servidor Y navegador
  signals.js           compras y ventas — servidor Y navegador
  symbols.js           catálogo de criptomonedas del desplegable
  klines.js            velas: validación, caché por timeframe y modo demo
  breakout.js          niveles, distancia en ATR y frecuencia histórica
  stream.js            WebSocket compartido hacia Binance → SSE a los clientes
  api.js               orquestación: descarga + caché + análisis
  analyze.js           consenso, ranking, confianza, arbitraje
  match.js             agrupación de eventos y opciones equivalentes
  normalize.js         precios, probabilidades, devig, similitud de texto
  cache.js             caché TTL con single-flight y stale opcional
  http.js              fetch con timeout y reintentos
  providers/           un módulo por plataforma
public/
  index.html           plataforma de trading (maquetación)
  app.js               gráfico, tabla multi-timeframe, ruptura y avisos
  predicciones.html    analizador de predicciones
data/demo/             datos de ejemplo (también usados por los tests)
scripts/smoke.js         valida las APIs reales antes de desplegar
scripts/build-static.js  instantánea estática autocontenida para compartir
deploy/                  unidad systemd y configuración de Nginx
.github/workflows/ci.yml tests en cada push + APIs reales una vez al día
Dockerfile, docker-compose.yml
test/                  165 tests, sin red
```
